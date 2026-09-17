"""The join between the turn's subject read and ``file_draft``.

Two units, one file, deliberately: the property is that the path the turn writes
is the path the tool later UPDATES. Each half tested alone would pass with the
two disagreeing — the loader would write a file, the tool would find no filing
record on the path it was given, post a ``create``, and the conversation would
end with two documents where the reader asked about one.

The conftest here supplies the real working directory and a signed turn; only
the two HTTP calls are doubles.
"""

from __future__ import annotations

from typing import Any

import pytest
from langgraph.store.memory import InMemoryStore

from aiq_agent.tools.documents import register as filing_tools
from aiq_agent.tools.documents.draft_store import DraftBackend
from aiq_agent.turn import subject_document
from aiq_agent.turn.payload import SubjectVersion

from .conftest import CONVERSATION
from .conftest import _responder

SUBJECT = SubjectVersion(document_id="doc-1", version_id="ver-1", state="draft")
BODY: dict[str, Any] = {
    "documentId": "doc-1",
    "versionId": "ver-1",
    "state": "draft",
    "contentHash": "hash-1",
    "filename": "piloti/doc-1/befund.md",
    "displayName": "Befund Fluchtwege",
    "content": "# Befund\n\nAbschnitt 3: GK 4.\n",
}


@pytest.fixture(autouse=True)
def _subject_store(_one_store: InMemoryStore, monkeypatch: pytest.MonkeyPatch) -> None:
    """The loader writes into the same working directory the tools read."""

    async def _backend(conversation_id: str, dsn: str | None = None) -> DraftBackend:
        return DraftBackend(store=_one_store, conversation_id=conversation_id)

    monkeypatch.setattr(subject_document, "get_draft_backend", _backend)


async def test_file_draft_updates_the_document_the_turn_read(monkeypatch, calls) -> None:
    monkeypatch.setattr(subject_document, "get_document_version_content", lambda *_: dict(BODY))
    path = await subject_document.load_subject_document(SUBJECT, conversation_id=CONVERSATION, organization_id="org_1")
    assert path == "/entwuerfe/Befund Fluchtwege.md"

    monkeypatch.setattr(
        filing_tools,
        "post_document_version",
        _responder(
            [{"documentId": "doc-1", "version": {"id": "ver-1", "state": "draft", "contentHash": "hash-2"}}], calls
        ),
    )
    answer = await filing_tools.run_file_draft(path)

    payload, _ = calls[0]
    # `update`, not `create`: one document, a second set of bytes on the version
    # that was already open — and the If-Match is the hash the READ reported, not
    # one computed here, so a reviewer's edit in between is a 409 rather than an
    # overwrite.
    assert payload["op"] == "update"
    assert payload["documentId"] == "doc-1"
    assert payload["versionId"] == "ver-1"
    assert payload["ifMatch"] == "hash-1"
    assert "abgelegt" in answer.lower()


async def test_the_turn_writes_a_path_file_draft_can_find(monkeypatch, calls) -> None:
    # The tool refuses a path that holds no draft. Naming the same file from both
    # sides is the whole contract, so the refusal must NOT be what comes back.
    monkeypatch.setattr(subject_document, "get_document_version_content", lambda *_: dict(BODY))
    path = await subject_document.load_subject_document(SUBJECT, conversation_id=CONVERSATION, organization_id="org_1")
    assert path is not None

    monkeypatch.setattr(filing_tools, "post_document_version", _responder([{"documentId": "doc-1"}], calls))
    assert "gibt es keinen Entwurf" not in await filing_tools.run_file_draft(path)
