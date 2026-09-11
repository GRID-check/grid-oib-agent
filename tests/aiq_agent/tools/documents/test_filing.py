"""``file_draft`` and ``submit_draft``: what goes on the wire, and what is refused.

The HTTP call is the only thing mocked. Everything else — the working directory,
the draft store's filing record, the card registry, the request context — is the
real thing, because the properties under test are properties of the seam: that
the SIGNED bytes leave unchanged, that a second filing of one path updates one
document instead of creating two, and that a run with no acting person files
nothing at all.

The doubles live in ``conftest.py``; so does every helper below the fixtures.
"""

from __future__ import annotations

from urllib.parse import parse_qs
from urllib.parse import urlsplit

from aiq_agent.tools.documents import filing
from aiq_agent.tools.documents import register as filing_tools
from aiq_agent.tools.documents.draft_store import FILED_DOCUMENT_KEY
from aiq_agent.tools.documents.draft_store import FILED_HASH_KEY
from aiq_agent.tools.documents.draft_store import FILED_STATE_KEY
from aiq_agent.tools.documents.draft_store import FILED_VERSION_KEY
from aiq_agent.tools.documents.draft_store import DraftBackend

from .conftest import BODY
from .conftest import CONVERSATION
from .conftest import DRAFT
from .conftest import ENVELOPE_HEADER
from .conftest import ENVELOPE_SIG
from .conftest import PROJECT
from .conftest import _bind_context
from .conftest import _draft_cards
from .conftest import _edit
from .conftest import _file
from .conftest import _responder
from .conftest import _stored
from .conftest import _submit
from .conftest import _version
from .conftest import _write
from .conftest import envelope


class TestFilingANewDraft:
    """The first ``file_draft`` for a path: one ``create``, and what it leaves behind."""

    async def test_it_posts_a_create_with_the_draft_bytes(self, _one_store, monkeypatch, calls) -> None:
        await _write(_one_store)
        await _file(monkeypatch, [{"documentId": "doc-1", "version": _version("ver-1", "draft", "h1")}], calls)

        payload, _ = calls[0]
        assert payload["op"] == "create"
        assert payload["projectId"] == PROJECT
        assert payload["content"] == BODY
        # The idempotency key is the CONVERSATION's, so a second turn writing the
        # same document lands on the same row rather than on a second one.
        assert payload["ref"] == f"{CONVERSATION}-aktenvermerk"

    async def test_the_title_is_the_documents_own_first_heading(self, _one_store, monkeypatch, calls) -> None:
        await _write(_one_store)
        await _file(monkeypatch, [{"documentId": "doc-1", "version": _version("ver-1", "draft", "h1")}], calls)
        assert calls[0][0]["title"] == "Aktenvermerk – Fluchtweg"

    async def test_an_explicit_title_wins(self, _one_store, monkeypatch, calls) -> None:
        await _write(_one_store)
        await _file(
            monkeypatch,
            [{"documentId": "doc-1", "version": _version("ver-1", "draft", "h1")}],
            calls,
            title="Vermerk Fluchtweglänge",
        )
        assert calls[0][0]["title"] == "Vermerk Fluchtweglänge"

    async def test_the_answer_says_it_is_a_draft_nobody_approved(self, _one_store, monkeypatch, calls) -> None:
        await _write(_one_store)
        message = await _file(
            monkeypatch, [{"documentId": "doc-1", "version": _version("ver-1", "draft", "h1")}], calls
        )
        assert "Aktenvermerk – Fluchtweg" in message
        assert "ENTWURF" in message
        assert "freigegeben" in message

    async def test_the_filing_is_remembered_on_the_draft(self, _one_store, monkeypatch, calls) -> None:
        await _write(_one_store)
        await _file(monkeypatch, [{"documentId": "doc-1", "version": _version("ver-1", "draft", "h1")}], calls)

        value = _stored(_one_store)
        assert value[FILED_DOCUMENT_KEY] == "doc-1"
        assert value[FILED_VERSION_KEY] == "ver-1"
        assert value[FILED_HASH_KEY] == "h1"
        assert value[FILED_STATE_KEY] == "draft"


class TestTheEnvelopeIsEchoed:
    """The identity rule of ADR-0054 §4, as a test rather than as a comment."""

    async def test_the_signed_bytes_leave_unchanged(self, _one_store, monkeypatch, calls) -> None:
        await _write(_one_store)
        await _file(monkeypatch, [{"documentId": "doc-1", "version": _version("ver-1", "draft", "h1")}], calls)

        _, signed = calls[0]
        assert signed.header == ENVELOPE_HEADER
        assert signed.signature == ENVELOPE_SIG

    async def test_the_acting_identity_is_never_in_the_body(self, _one_store, monkeypatch, calls) -> None:
        """A userId in the body would be a user this tier chose."""
        await _write(_one_store)
        await _file(monkeypatch, [{"documentId": "doc-1", "version": _version("ver-1", "draft", "h1")}], calls)

        payload, _ = calls[0]
        assert "userId" not in payload
        assert "organizationId" not in payload

    async def test_a_run_without_an_envelope_files_nothing(self, _one_store, monkeypatch, calls) -> None:
        await _write(_one_store)
        _bind_context(monkeypatch, headers={"x-grid-project-id": PROJECT}, conversation_id=CONVERSATION)

        message = await _file(monkeypatch, [], calls)
        assert "Sitzungsnachweis" in message
        assert calls == []
        assert FILED_DOCUMENT_KEY not in _stored(_one_store)

    async def test_an_envelope_for_another_conversation_files_nothing(self, _one_store, monkeypatch, calls) -> None:
        """Two sources for one identity that disagree is not a case to guess through."""
        await _write(_one_store)
        header, sig = envelope({"organizationId": "org_1", "userId": "user_1", "conversationId": "conv-9"})
        _bind_context(
            monkeypatch,
            headers={
                "x-grid-project-id": PROJECT,
                "x-grid-request-context": header,
                "x-grid-request-context-sig": sig,
            },
            conversation_id=CONVERSATION,
        )

        message = await _file(monkeypatch, [], calls)
        assert "Fehler" in message
        assert calls == []


class TestFilingTheSameDraftTwice:
    """A second ``file_draft`` updates the open version — it never forks a document."""

    async def test_the_second_call_is_an_update_with_the_servers_hash(self, _one_store, monkeypatch, calls) -> None:
        await _write(_one_store)
        await _file(monkeypatch, [{"documentId": "doc-1", "version": _version("ver-1", "draft", "h1")}], calls)

        calls.clear()
        await _edit(_one_store, "42 m", "42 m (ergänzt)")
        await _file(monkeypatch, [{"documentId": "doc-1", "version": _version("ver-1", "draft", "h2")}], calls)

        payload, _ = calls[0]
        assert payload["op"] == "update"
        assert payload["documentId"] == "doc-1"
        assert payload["versionId"] == "ver-1"
        # The hash the SERVER last reported, not one computed from our copy: a
        # local hash would agree with itself and overwrite a reviewer's edit.
        assert payload["ifMatch"] == "h1"
        assert "42 m (ergänzt)" in payload["content"]

    async def test_an_edit_does_not_lose_the_filing(self, _one_store, monkeypatch, calls) -> None:
        """DeepAgents rebuilds the stored value on every edit; the record is re-stamped."""
        await _write(_one_store)
        await _file(monkeypatch, [{"documentId": "doc-1", "version": _version("ver-1", "draft", "h1")}], calls)

        backend = DraftBackend(store=_one_store, conversation_id=CONVERSATION)
        result = await backend.aedit(DRAFT, "42 m", "38 m")
        assert result.error is None
        assert _stored(_one_store)[FILED_DOCUMENT_KEY] == "doc-1"

    async def test_a_lost_mapping_replaces_the_bytes_rather_than_claiming_them(
        self, _one_store, monkeypatch, calls
    ) -> None:
        """`alreadyFiled` means no version was written, so the project still holds the OLD bytes."""
        await _write(_one_store)
        await _file(
            monkeypatch,
            [
                {"documentId": "doc-1", "alreadyFiled": True, "version": _version("ver-1", "draft", "h1")},
                {"documentId": "doc-1", "version": _version("ver-1", "draft", "h2")},
            ],
            calls,
        )
        assert [payload["op"] for payload, _ in calls] == ["create", "update"]
        assert calls[1][0]["ifMatch"] == "h1"

    async def test_a_lost_mapping_onto_a_SUBMITTED_version_is_refused_not_announced(
        self, _one_store, monkeypatch, calls
    ) -> None:
        """`alreadyFiled` plus a state nobody may replace: nothing was written.

        The working directory lost its mapping (a restart, a retried turn), so
        the tool takes the `create` branch — and the reference resolves onto a
        version already `in_review`, which no machine may replace. Reporting
        „Im Projekt abgelegt" here would tell the reader their revision is in
        the project while the reviewer still holds the old bytes.
        """
        await _write(_one_store)
        message = await _file(
            monkeypatch,
            [{"documentId": "doc-1", "alreadyFiled": True, "version": _version("ver-1", "in_review", "h1")}],
            calls,
        )

        assert "zur Freigabe" in message
        assert "abgelegt" not in message.split("Fehler:")[-1].split(".")[0]
        # One call, and it was the create that came back already filed. No
        # update was attempted, and nothing claims a version was written.
        assert [payload["op"] for payload, _ in calls] == ["create"]
        assert FILED_DOCUMENT_KEY not in _stored(_one_store)

    async def test_a_draft_already_in_review_is_not_replaced(self, _one_store, monkeypatch, calls) -> None:
        await _write(_one_store)
        await _file(monkeypatch, [{"documentId": "doc-1", "version": _version("ver-1", "in_review", "h1")}], calls)

        calls.clear()
        message = await _file(monkeypatch, [], calls)
        assert "zur Freigabe" in message
        assert calls == []


class TestSubmitting:
    """The second door: a filed draft goes to a person."""

    async def test_it_posts_a_submit_for_the_open_version(self, _one_store, monkeypatch, calls) -> None:
        await _write(_one_store)
        await _file(monkeypatch, [{"documentId": "doc-1", "version": _version("ver-1", "draft", "h1")}], calls)

        calls.clear()
        message = await _submit(
            monkeypatch, [{"documentId": "doc-1", "version": _version("ver-1", "in_review", "h1")}], calls
        )

        payload, signed = calls[0]
        assert payload == {
            "op": "submit",
            "documentId": "doc-1",
            "versionId": "ver-1",
            "reviewerUserIds": [],
        }
        assert signed.header == ENVELOPE_HEADER
        assert "Freigabe" in message
        # Nobody was named, so the route submits to the project's editors — and
        # the sentence says so, because „wartet auf eine Person" leaves the
        # reader wondering which one.
        assert "an die Bearbeiter des Projekts" in message
        assert "ENTWURF" in message
        assert _stored(_one_store)[FILED_STATE_KEY] == "in_review"

    async def test_a_named_reviewer_travels_as_a_NAME(self, _one_store, monkeypatch, calls) -> None:
        """This tier has no member roster; the BFF resolves the name.

        The same shape `assign_document` uses, and for the same reason: a
        reviewer resolved here would be a person this process guessed.
        """
        await _write(_one_store)
        await _file(monkeypatch, [{"documentId": "doc-1", "version": _version("ver-1", "draft", "h1")}], calls)

        calls.clear()
        message = await _submit(
            monkeypatch,
            [{"documentId": "doc-1", "version": _version("ver-1", "in_review", "h1")}],
            calls,
            reviewer="  Anna   Berger ",
        )

        payload, _ = calls[0]
        assert payload["reviewer"] == "Anna Berger"
        assert payload["reviewerUserIds"] == []
        assert "an Anna Berger" in message

    async def test_no_reviewer_puts_no_field_on_the_wire(self, _one_store, monkeypatch, calls) -> None:
        await _write(_one_store)
        await _file(monkeypatch, [{"documentId": "doc-1", "version": _version("ver-1", "draft", "h1")}], calls)

        calls.clear()
        await _submit(monkeypatch, [{"documentId": "doc-1", "version": _version("ver-1", "in_review", "h1")}], calls)

        assert "reviewer" not in calls[0][0]

    async def test_a_person_the_project_does_not_have_is_a_refusal_in_those_words(
        self, _one_store, monkeypatch, calls
    ) -> None:
        """The BFF resolves the name and answers 400. The generic filing error
        would send the model hunting for a filing problem instead of asking the
        reader who they meant."""
        await _write(_one_store)
        await _file(monkeypatch, [{"documentId": "doc-1", "version": _version("ver-1", "draft", "h1")}], calls)

        def _refuse(payload, signed):  # noqa: ANN001, ARG001
            raise filing.FilingError("the document API refused the call (400)", status=400, code="UNKNOWN_REVIEWER")

        monkeypatch.setattr(filing_tools, "post_document_version", _refuse)
        message = await filing_tools.run_submit_draft(DRAFT, "Anna Berger")

        assert "Ich kenne keine Person namens „Anna Berger“" in message
        assert "Es wurde nichts eingereicht" in message
        assert "Bearbeiter des Projekts" in message
        assert _stored(_one_store)[FILED_STATE_KEY] == "draft"

    async def test_a_400_without_a_named_reviewer_keeps_the_filing_wording(
        self, _one_store, monkeypatch, calls
    ) -> None:
        """The reviewer refusal is scoped to the argument that can produce it."""
        await _write(_one_store)
        await _file(monkeypatch, [{"documentId": "doc-1", "version": _version("ver-1", "draft", "h1")}], calls)

        def _refuse(payload, signed):  # noqa: ANN001, ARG001
            raise filing.FilingError("the document API refused the call (400)", status=400)

        monkeypatch.setattr(filing_tools, "post_document_version", _refuse)
        message = await filing_tools.run_submit_draft(DRAFT)

        assert "Ich kenne keine Person" not in message
        assert "Arbeitsordner" in message

    async def test_an_unfiled_draft_cannot_be_submitted(self, _one_store, monkeypatch, calls) -> None:
        await _write(_one_store)
        message = await _submit(monkeypatch, [], calls)
        assert "`file_draft`" in message
        assert calls == []

    async def test_submitting_twice_is_refused_rather_than_repeated(self, _one_store, monkeypatch, calls) -> None:
        await _write(_one_store)
        await _file(monkeypatch, [{"documentId": "doc-1", "version": _version("ver-1", "draft", "h1")}], calls)
        calls.clear()
        await _submit(monkeypatch, [{"documentId": "doc-1", "version": _version("ver-1", "in_review", "h1")}], calls)

        calls.clear()
        message = await _submit(monkeypatch, [], calls)
        assert "bereits eingereicht" in message
        assert calls == []


class TestRefusals:
    """Every path that must leave the project untouched."""

    async def test_without_a_project_nothing_is_filed(self, _one_store, monkeypatch, calls) -> None:
        await _write(_one_store)
        _bind_context(
            monkeypatch,
            headers={
                "x-grid-request-context": ENVELOPE_HEADER,
                "x-grid-request-context-sig": ENVELOPE_SIG,
            },
            conversation_id=CONVERSATION,
        )
        # The envelope names a project; the tool reads the header, and this run
        # has none — the phrase the design of record asks for, verbatim.
        monkeypatch.setattr(filing_tools.project_context, "get_project_id_from_context", lambda: None)

        message = await _file(monkeypatch, [], calls)
        assert "In diesem Gespräch gibt es kein Projekt" in message
        assert calls == []

    async def test_a_path_outside_the_working_directory_is_refused(self, monkeypatch, calls) -> None:
        monkeypatch.setattr(filing_tools, "post_document_version", _responder([], calls))
        message = await filing_tools.run_file_draft("/etc/passwd", "")
        assert "Arbeitsordner" in message
        assert calls == []

    async def test_a_path_that_was_never_written_is_refused(self, monkeypatch, calls) -> None:
        message = await _file(monkeypatch, [], calls)
        assert "gibt es keinen Entwurf" in message
        assert calls == []

    async def test_a_refused_call_says_the_draft_is_still_in_the_working_directory(
        self, _one_store, monkeypatch, calls
    ) -> None:
        await _write(_one_store)

        def _boom(payload, signed):  # noqa: ANN001, ARG001
            raise filing.FilingError("the document API refused the call (403)", status=403, code="FORBIDDEN")

        monkeypatch.setattr(filing_tools, "post_document_version", _boom)
        message = await filing_tools.run_file_draft(DRAFT, "")
        assert "Arbeitsordner" in message
        assert FILED_DOCUMENT_KEY not in _stored(_one_store)


class TestTheCard:
    """What the reader sees after a filing."""

    async def test_the_card_carries_the_document_and_its_state(self, _one_store, monkeypatch, calls, registry) -> None:
        await _write(_one_store)
        await _file(monkeypatch, [{"documentId": "doc-1", "version": _version("ver-1", "draft", "h1")}], calls)

        card = _draft_cards(registry)[-1]
        assert card["document_id"] == "doc-1"
        assert card["version_id"] == "ver-1"
        assert card["version_state"] == "draft"

    async def test_an_unfiled_write_emits_a_card_with_no_document(self, _one_store, registry) -> None:
        await _write(_one_store)
        card = _draft_cards(registry)[-1]
        assert "document_id" not in card
        assert "version_state" not in card

    async def test_submitting_re_emits_the_card_in_its_new_state(
        self, _one_store, monkeypatch, calls, registry
    ) -> None:
        await _write(_one_store)
        await _file(monkeypatch, [{"documentId": "doc-1", "version": _version("ver-1", "draft", "h1")}], calls)
        calls.clear()
        await _submit(monkeypatch, [{"documentId": "doc-1", "version": _version("ver-1", "in_review", "h1")}], calls)
        assert _draft_cards(registry)[-1]["version_state"] == "in_review"


class TestTheReadRouteIsScopedToTheConversation:
    """``GET .../content`` carries BOTH predicates, and the transport is the real one.

    A version id is the only thing a client picks. The organization alone would
    let one reach any version in the tenant, so the BFF additionally requires the
    conversation and refuses unless the version is that conversation's subject —
    which is worth nothing if the parameter never leaves this side.
    """

    def test_both_scopes_reach_the_url(self, monkeypatch) -> None:
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "internal-token")
        seen: list[str] = []

        class _Response:
            def __enter__(self):
                return self

            def __exit__(self, *_exc) -> bool:
                return False

            def read(self) -> bytes:
                return b'{"content": "x", "documentId": "doc-9"}'

        class _Opener:
            def open(self, request, timeout=None):  # noqa: ANN001, ARG002
                seen.append(request.full_url)
                return _Response()

        monkeypatch.setattr(filing, "_opener", _Opener())
        body = filing.get_document_version_content("ver 9", "org_1", "conv-1")

        assert body["documentId"] == "doc-9"
        assert len(seen) == 1
        query = parse_qs(urlsplit(seen[0]).query)
        assert query["organizationId"] == ["org_1"]
        assert query["conversationId"] == ["conv-1"]
        assert "/document-versions/ver%209/content" in seen[0]
