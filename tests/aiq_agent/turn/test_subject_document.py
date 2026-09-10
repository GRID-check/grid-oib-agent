"""Reading an unpublished subject document into the conversation's working directory.

The HTTP read is the only double. The working directory is the real
:class:`DraftBackend` on an in-memory store, because what is being asserted is
what the NEXT tool finds there: the bytes, and the filing record that decides
whether ``file_draft`` updates one document or files a second one.
"""

from __future__ import annotations

import logging
from typing import Any

import pytest
from langgraph.store.memory import InMemoryStore

from aiq_agent.cards.registry import CardRegistry
from aiq_agent.cards.registry import reset_card_registry
from aiq_agent.cards.registry import set_card_registry
from aiq_agent.tools.documents import draft_store
from aiq_agent.tools.documents.draft_store import FILED_DOCUMENT_KEY
from aiq_agent.tools.documents.draft_store import FILED_HASH_KEY
from aiq_agent.tools.documents.draft_store import FILED_STATE_KEY
from aiq_agent.tools.documents.draft_store import FILED_VERSION_KEY
from aiq_agent.tools.documents.draft_store import DraftBackend
from aiq_agent.tools.documents.filing import FilingError
from aiq_agent.turn import subject_document
from aiq_agent.turn.payload import SubjectVersion

CONVERSATION = "conv-subject-1"
ORGANIZATION = "org_1"
TEXT = "# Befund\n\nAbschnitt 3: GK 4, weil das oberste Geschoß bei 11 m liegt.\n"

BODY: dict[str, Any] = {
    "documentId": "doc-9",
    "versionId": "ver-9",
    "versionNumber": 1,
    "state": "draft",
    "contentHash": "hash-9",
    "contentType": "text/markdown",
    "filename": "piloti/doc-9/befund.md",
    "displayName": "Befund Fluchtwege",
    "content": TEXT,
}

OPEN = SubjectVersion(document_id="doc-9", version_id="ver-9", state="draft")
PUBLISHED = SubjectVersion(document_id="doc-9", version_id="ver-9", state="published")


@pytest.fixture
def store(monkeypatch: pytest.MonkeyPatch) -> InMemoryStore:
    """One working directory, shared by the loader and the assertions."""
    memory = InMemoryStore()

    async def _backend(conversation_id: str, dsn: str | None = None) -> DraftBackend:
        return DraftBackend(store=memory, conversation_id=conversation_id)

    monkeypatch.setattr(subject_document, "get_draft_backend", _backend)
    return memory


@pytest.fixture
def reads(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str]]:
    """Every internal read the loader makes, with the body it gets back."""
    seen: list[tuple[str, str]] = []

    def _read(version_id: str, organization_id: str) -> dict[str, Any]:
        seen.append((version_id, organization_id))
        return dict(BODY)

    monkeypatch.setattr(subject_document, "get_document_version_content", _read)
    return seen


def _stored(store: InMemoryStore, path: str) -> dict | None:
    item = store.get(draft_store.draft_namespace(CONVERSATION), path)
    return item.value if item else None


async def _load(subject: SubjectVersion) -> str | None:
    return await subject_document.load_subject_document(
        subject, conversation_id=CONVERSATION, organization_id=ORGANIZATION
    )


class TestAnUnpublishedSubject:
    """The case the whole module exists for: a version retrieval cannot see."""

    async def test_the_text_lands_in_the_working_directory(self, store, reads) -> None:
        path = await _load(OPEN)

        assert path == "/entwuerfe/Befund Fluchtwege.md"
        assert reads == [("ver-9", ORGANIZATION)]
        assert _stored(store, path)["content"] == TEXT

    async def test_it_is_named_after_the_documents_LABEL_not_its_filename(self, store, reads) -> None:
        # The stored filename is namespaced (`piloti/<id>/<name>`), which is a
        # retrieval key and not a name a person would type. The reader sees the
        # display name in the Files pane, so that is what the file is called.
        path = await _load(OPEN)
        assert path == f"{draft_store.DRAFT_ROOT}Befund Fluchtwege.md"
        assert "/" not in path[len(draft_store.DRAFT_ROOT) :]

    async def test_the_filing_record_names_the_document_and_the_version(self, store, reads) -> None:
        # THE JOIN. Without these four keys `file_draft` sees an unfiled draft,
        # posts a `create`, and one document becomes two.
        value = _stored(store, await _load(OPEN))
        assert value[FILED_DOCUMENT_KEY] == "doc-9"
        assert value[FILED_VERSION_KEY] == "ver-9"
        assert value[FILED_HASH_KEY] == "hash-9"
        assert value[FILED_STATE_KEY] == "draft"

    async def test_the_ceiling_still_applies_to_bytes_from_outside(self, store, monkeypatch) -> None:
        # Through the backend, not the store: a subject larger than one
        # conversation's whole allowance is refused exactly as a model-written
        # draft would be, and the turn carries on without it.
        oversized = dict(BODY, content="x" * (draft_store.MAX_DRAFT_BYTES + 1))
        monkeypatch.setattr(subject_document, "get_document_version_content", lambda *_: oversized)

        assert await _load(OPEN) is None
        assert _stored(store, "/entwuerfe/Befund Fluchtwege.md") is None


class TestASecondTurnOfTheSameConversation:
    """A subject is loaded once per turn; the file is not rewritten every time."""

    async def test_it_leaves_the_models_edits_alone(self, store, reads) -> None:
        path = await _load(OPEN)
        backend = DraftBackend(store=store, conversation_id=CONVERSATION)
        edited = await backend.aedit(path, "GK 4", "GK 5")
        assert edited.error is None

        assert await _load(OPEN) == path
        # By turn three the model may have revised the draft at the reader's
        # request. Rewriting the stored bytes over it would silently undo an
        # edit they watched happen.
        assert "GK 5" in _stored(store, path)["content"]
        assert len(reads) == 2  # asked, and decided nothing had to be written

    async def test_a_reviewers_change_does_not_clobber_the_working_copy(self, store, monkeypatch) -> None:
        monkeypatch.setattr(subject_document, "get_document_version_content", lambda *_: dict(BODY))
        path = await _load(OPEN)

        # The version's bytes moved on the server between two turns. The
        # conversation's copy stands, and the filing record still carries the
        # hash it was made from — so filing it back is an If-Match conflict
        # rather than an overwrite of somebody's edit.
        moved = dict(BODY, contentHash="hash-10", content="# Befund\n\nAbschnitt 3: GK 5.\n")
        monkeypatch.setattr(subject_document, "get_document_version_content", lambda *_: moved)
        assert await _load(OPEN) == path
        assert "GK 4" in _stored(store, path)["content"]
        assert _stored(store, path)[FILED_HASH_KEY] == "hash-9"

    async def test_a_path_belonging_to_another_document_is_refused(self, store, reads, monkeypatch) -> None:
        # Two documents in one project can share a display name, and the path is
        # built from that name. Reusing the path would file one document's text
        # as another's.
        await _load(OPEN)
        other = dict(BODY, documentId="doc-11", versionId="ver-11", contentHash="hash-11")
        monkeypatch.setattr(subject_document, "get_document_version_content", lambda *_: other)

        assert await _load(SubjectVersion("doc-11", "ver-11", "draft")) is None
        assert _stored(store, "/entwuerfe/Befund Fluchtwege.md")[FILED_DOCUMENT_KEY] == "doc-9"

    async def test_it_announces_no_draft_card_for_a_document_nobody_wrote(self, store, reads) -> None:
        # Every write through the backend normally puts a „Entwurf geschrieben"
        # card in front of the reader. This write is not something the model
        # did — the reader pressed „Besprechen" on a document that exists — so
        # the card would be a claim about work nobody performed.
        registry = CardRegistry()
        token = set_card_registry(registry)
        try:
            await _load(OPEN)
        finally:
            reset_card_registry(token)
        assert [card for card in registry.snapshot() if card["type"] == "document_draft"] == []


class TestAPublishedSubject:
    """Nothing changes: the chunks exist and the focus filter works."""

    async def test_nothing_is_read_and_nothing_is_written(self, store, reads) -> None:
        assert await _load(PUBLISHED) is None
        assert reads == []
        assert _stored(store, "/entwuerfe/Befund Fluchtwege.md") is None

    async def test_a_turn_with_no_subject_at_all_is_a_no_op(self, store, reads) -> None:
        assert await _load(SubjectVersion()) is None
        assert reads == []

    async def test_an_incomplete_subject_is_not_a_subject(self, store, reads) -> None:
        # A state without an id cannot be read, and guessing which version was
        # meant is exactly the guess this whole path exists to remove.
        assert await _load(SubjectVersion(document_id="doc-9", state="draft")) is None
        assert reads == []


class TestWhenTheBytesDoNotArrive:
    """Every miss costs the model one document and never the turn."""

    async def test_a_refusal_is_logged_and_the_turn_continues(
        self, store, monkeypatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        def _refuse(version_id: str, organization_id: str) -> dict[str, Any]:
            raise FilingError("the document API refused the read (404)", status=404)

        monkeypatch.setattr(subject_document, "get_document_version_content", _refuse)
        with caplog.at_level(logging.WARNING):
            assert await _load(OPEN) is None
        assert "ver-9" in caplog.text

    async def test_an_unreachable_bff_is_logged_and_the_turn_continues(
        self, store, monkeypatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        def _unreachable(version_id: str, organization_id: str) -> dict[str, Any]:
            raise FilingError("the document API could not be reached")

        monkeypatch.setattr(subject_document, "get_document_version_content", _unreachable)
        with caplog.at_level(logging.WARNING):
            assert await _load(OPEN) is None

    async def test_empty_bytes_write_nothing(self, store, monkeypatch) -> None:
        monkeypatch.setattr(subject_document, "get_document_version_content", lambda *_: dict(BODY, content="   "))
        assert await _load(OPEN) is None
        assert _stored(store, "/entwuerfe/Befund Fluchtwege.md") is None

    async def test_an_unexpected_failure_never_reaches_the_turn(self, store, monkeypatch) -> None:
        def _explode(version_id: str, organization_id: str) -> dict[str, Any]:
            raise RuntimeError("boom")

        monkeypatch.setattr(subject_document, "get_document_version_content", _explode)
        assert await _load(OPEN) is None

    async def test_a_run_with_no_conversation_has_nowhere_to_put_a_file(self, store, reads) -> None:
        assert (
            await subject_document.load_subject_document(OPEN, conversation_id=None, organization_id=ORGANIZATION)
            is None
        )
        assert reads == []

    async def test_a_run_with_no_organization_does_not_read(self, store, reads) -> None:
        # The organization is the whole of the internal route's predicate, and
        # it comes from the signed envelope. Without one there is nothing to
        # scope the read to, and a read with no scope is the one this must not make.
        assert (
            await subject_document.load_subject_document(OPEN, conversation_id=CONVERSATION, organization_id=None)
            is None
        )
        assert reads == []


class TestTheNameItBuilds:
    """A display name is free text; a working-directory path is not."""

    @pytest.mark.parametrize(
        ("display_name", "expected"),
        [
            ("Befund", "/entwuerfe/Befund.md"),
            ("piloti/doc-9/Befund", "/entwuerfe/piloti-doc-9-Befund.md"),
            ("../../etc/passwd", "/entwuerfe/-.-etc-passwd.md"),
            ("Befund.md", "/entwuerfe/Befund.md"),
            ("  ", "/entwuerfe/dokument.md"),
            ("", "/entwuerfe/dokument.md"),
        ],
    )
    def test_it_is_always_one_file_in_the_one_directory(self, display_name: str, expected: str) -> None:
        assert subject_document.draft_path(display_name) == expected

    @pytest.mark.parametrize(
        "display_name",
        ["../../etc/passwd", "..", "a..b", "Plan ..  Stand", "/etc/../etc/passwd"],
    )
    def test_it_never_builds_a_path_the_working_directory_would_refuse(self, display_name: str) -> None:
        # `path_refusal` rejects any path containing `..`, and it is the same
        # guard `file_draft` runs. A name that produced one would leave a file
        # the reader sees in `ls` and no tool can write to or file.
        assert draft_store.path_refusal(subject_document.draft_path(display_name)) is None

    def test_a_very_long_name_still_fits(self) -> None:
        path = subject_document.draft_path("A" * 500)
        assert path.startswith(draft_store.DRAFT_ROOT)
        assert len(path) <= len(draft_store.DRAFT_ROOT) + subject_document.MAX_NAME_CHARS + len(".md")

    def test_the_name_is_NFC_normalised_like_everything_else_in_the_store(self) -> None:
        # `Gebäudeklasse` typed decomposed and typed composed are different
        # strings; two paths for one document is the same bug `edit_file` paid
        # for once already.
        assert subject_document.draft_path("Gebäude") == subject_document.draft_path("Gebäude")
