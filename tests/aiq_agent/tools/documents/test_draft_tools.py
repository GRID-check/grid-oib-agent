"""The four verbs Piloti is offered, and the card a written draft leaves.

The tools themselves are stock DeepAgents; what this repo decides is WHICH of
them the model sees, what they are called in German, whose working directory
they reach, and what the reader is shown afterwards.
"""

from __future__ import annotations

import pytest
from langgraph.store.memory import InMemoryStore

from aiq_agent.cards.catalog import SYSTEM_CARD_TYPES
from aiq_agent.cards.registry import CardRegistry
from aiq_agent.cards.registry import reset_card_registry
from aiq_agent.cards.registry import set_card_registry
from aiq_agent.tools.documents import tools as draft_tools_module
from aiq_agent.tools.documents.cards import draft_title
from aiq_agent.tools.documents.cards import emit_draft_card
from aiq_agent.tools.documents.draft_store import DRAFT_ROOT
from aiq_agent.tools.documents.draft_store import DraftBackend
from aiq_agent.tools.documents.tools import DRAFT_TOOL_NAMES
from aiq_agent.tools.documents.tools import draft_tools
from aiq_agent.tools.documents.tools import draft_tools_for_turn

DRAFT = f"{DRAFT_ROOT}aktenvermerk.md"


@pytest.fixture
def backend() -> DraftBackend:
    return DraftBackend(store=InMemoryStore(), conversation_id="conv-1")


@pytest.fixture
def cards():
    registry = CardRegistry()
    token = set_card_registry(registry)
    try:
        yield registry
    finally:
        reset_card_registry(token)


class TestWhichToolsAreBound:
    def test_exactly_the_four_verbs(self, backend: DraftBackend) -> None:
        assert [tool.name for tool in draft_tools(backend)] == list(DRAFT_TOOL_NAMES)

    def test_nothing_that_searches_or_executes_is_bound(self, backend: DraftBackend) -> None:
        """`glob`/`grep` buy nothing over one flat directory; `execute` has no sandbox."""
        names = {tool.name for tool in draft_tools(backend)}
        assert not names & {"glob", "grep", "execute"}


class TestTheDescriptions:
    def test_they_are_german(self, backend: DraftBackend) -> None:
        """Every stock English description is replaced, not merely extended."""
        for tool in draft_tools(backend):
            assert any(word in tool.description for word in ("Entwurf", "Entwürfe", "Arbeitsordner"))
            assert "the filesystem" not in tool.description

    def test_the_unenforced_read_before_edit_claim_is_gone(self, backend: DraftBackend) -> None:
        """DeepAgents' stock text claims it; nothing here checks it.

        An instruction the system does not enforce is one the model learns to
        ignore, and it takes the enforced parts of the description with it.
        """
        for tool in draft_tools(backend):
            assert "You must read the file" not in tool.description

    def test_edit_says_where_to_anchor_and_what_not_to_copy(self, backend: DraftBackend) -> None:
        """The two things that make an exact-string replacement land."""
        edit = next(tool for tool in draft_tools(backend) if tool.name == "edit_file")
        assert "Überschrift" in edit.description
        assert "Absatz" in edit.description
        assert "Zeilennummern" in edit.description

    def test_read_warns_that_line_numbers_are_not_in_the_file(self, backend: DraftBackend) -> None:
        read = next(tool for tool in draft_tools(backend) if tool.name == "read_file")
        assert "Zeilennummer" in read.description

    def test_write_names_the_document_kinds_and_the_root(self, backend: DraftBackend) -> None:
        write = next(tool for tool in draft_tools(backend) if tool.name == "write_file")
        assert DRAFT_ROOT in write.description
        assert "Aktenvermerk" in write.description


class TestTheTurnFactory:
    @pytest.mark.asyncio
    async def test_no_conversation_id_means_no_tools(self, monkeypatch) -> None:
        """A CLI run, an eval or a job worker has nothing to namespace a directory by.

        The alternative is one working directory shared by everyone, which is
        worse than not drafting at all.
        """
        monkeypatch.setattr(draft_tools_module, "get_conversation_id_from_context", lambda: None)
        assert await draft_tools_for_turn() == []

    @pytest.mark.asyncio
    async def test_a_conversation_id_gets_its_own_directory(self, monkeypatch, backend: DraftBackend) -> None:
        seen: dict[str, str] = {}

        async def _backend(conversation_id: str):
            seen["conversation_id"] = conversation_id
            return backend

        monkeypatch.setattr(draft_tools_module, "get_conversation_id_from_context", lambda: "conv-7")
        monkeypatch.setattr(draft_tools_module, "get_draft_backend", _backend)

        assert [tool.name for tool in await draft_tools_for_turn()] == list(DRAFT_TOOL_NAMES)
        assert seen == {"conversation_id": "conv-7"}

    @pytest.mark.asyncio
    async def test_an_unreachable_store_costs_the_drafting_not_the_turn(self, monkeypatch, caplog) -> None:
        async def _boom(_conversation_id: str):
            raise RuntimeError("no database here")

        monkeypatch.setattr(draft_tools_module, "get_conversation_id_from_context", lambda: "conv-7")
        monkeypatch.setattr(draft_tools_module, "get_draft_backend", _boom)

        with caplog.at_level("WARNING"):
            assert await draft_tools_for_turn() == []
        assert "Working directory unavailable" in caplog.text


class TestTheDraftCard:
    def test_it_is_a_system_card(self) -> None:
        """The model must not be able to fabricate a draft: the card names a real file."""
        assert "document_draft" in SYSTEM_CARD_TYPES

    def test_the_title_is_the_documents_own_first_heading(self) -> None:
        assert draft_title(DRAFT, "# Aktenvermerk Brandschutz\n\nText\n") == "Aktenvermerk Brandschutz"

    def test_a_document_without_a_heading_is_named_by_its_file(self) -> None:
        assert draft_title(DRAFT, "Nur Text\n") == "aktenvermerk.md"

    def test_a_writing_verb_puts_a_card_up(self, backend: DraftBackend, cards: CardRegistry) -> None:
        backend.write(DRAFT, "# Aktenvermerk\n\nGebäudeklasse 4\n")
        assert cards.snapshot() == [
            {
                "type": "document_draft",
                "title": "Aktenvermerk",
                "path": DRAFT,
                "bytes": len("# Aktenvermerk\n\nGebäudeklasse 4\n".encode()),
                "version": 1,
            }
        ]

    def test_an_edit_puts_up_the_next_version(self, backend: DraftBackend, cards: CardRegistry) -> None:
        backend.write(DRAFT, "# Aktenvermerk\n\nPunkt 3\n")
        backend.edit(DRAFT, "Punkt 3", "Punkt 3 gekürzt")
        assert [card["version"] for card in cards.snapshot()] == [1, 2]

    def test_a_refused_verb_puts_up_nothing(self, backend: DraftBackend, cards: CardRegistry) -> None:
        backend.write(DRAFT, "# Aktenvermerk\n")
        backend.write(DRAFT, "# Noch einmal\n")
        backend.edit(DRAFT, "gibt es nicht", "x")
        assert len(cards.snapshot()) == 1

    def test_no_card_channel_is_not_a_failed_write(self, backend: DraftBackend) -> None:
        """The write is the product; the card is only how it is announced."""
        assert emit_draft_card(path=DRAFT, content="# Vermerk\n", version=1) is False
        assert backend.write(DRAFT, "# Vermerk\n").error is None
