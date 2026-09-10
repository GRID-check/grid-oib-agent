"""The four write-side workspace tools: what they resolve, and what they refuse.

Every test here drives the inner function NAT yields, with the turn's inventory
and a card registry bound the way a real turn binds them. Two properties are
what this file exists to hold:

* **Nothing is written.** There is no writer to mock, because there is none in
  the module. What is asserted instead is the tool RESULT, which has to say so
  in words the model cannot read as success.
* **Nothing is guessed.** A name that resolves to two files, or to none, comes
  back as a question — never as a proposal naming one of them.
"""

from unittest.mock import MagicMock

import pytest

import aiq_agent.project_context as pc
from aiq_agent.cards.registry import CardRegistry
from aiq_agent.cards.registry import reset_card_registry
from aiq_agent.cards.registry import set_card_registry
from aiq_agent.knowledge.inventory import set_turn_documents
from aiq_agent.knowledge.schema import AvailableDocument
from aiq_agent.tools.files import resolve
from aiq_agent.tools.files.register import AssignDocumentConfig
from aiq_agent.tools.files.register import CreateFolderConfig
from aiq_agent.tools.files.register import MoveDocumentConfig
from aiq_agent.tools.files.register import RenameDocumentConfig
from aiq_agent.tools.files.register import assign_document
from aiq_agent.tools.files.register import create_folder
from aiq_agent.tools.files.register import move_document
from aiq_agent.tools.files.register import rename_document

INVENTORY = [
    AvailableDocument(
        file_name="Brandschutzkonzept.pdf",
        shelf="project",
        collection="proj_1",
        folder_path="Nachweise",
    ),
    AvailableDocument(
        file_name="Grundriss EG.pdf",
        shelf="project",
        collection="proj_1",
        folder_path="Einreichung/Pläne",
    ),
    AvailableDocument(file_name="Grundriss OG.pdf", shelf="project", collection="proj_1", folder_path=None),
    AvailableDocument(file_name="Musterbescheid.pdf", shelf="archiv", collection="archiv_1"),
    # Neither shelf is the reader's to organise: the platform corpus belongs to
    # nobody here, and a session attachment is not a project document.
    AvailableDocument(file_name="OIB-RL2.pdf", shelf="base", collection="oib"),
    AvailableDocument(file_name="Anhang.pdf", shelf="session", collection="s_1"),
]


@pytest.fixture
def registry():
    """A bound card registry, the way a turn binds one."""
    registry = CardRegistry()
    token = set_card_registry(registry)
    yield registry
    reset_card_registry(token)


@pytest.fixture(autouse=True)
def turn(monkeypatch):
    """A project-scoped turn that can see the inventory above."""
    monkeypatch.setattr(pc, "get_project_id_from_context", lambda: "p1")
    set_turn_documents(INVENTORY)
    yield
    set_turn_documents(None)


async def _call(registration, config, **params) -> str:
    async with registration(config, MagicMock()) as info:
        return await info.single_fn(info.input_schema(**params))


async def _move(**params) -> str:
    return await _call(move_document, MoveDocumentConfig(), **params)


# ── Resolution: the part that must never guess ──────────────────────────────


class TestResolution:
    def test_an_exact_name_resolves_with_its_shelf_and_folder(self):
        hit = resolve.resolve_document("Brandschutzkonzept.pdf")
        assert isinstance(hit, resolve.ResolvedDocument)
        assert (hit.source, hit.folder_path) == ("projekt", "Nachweise")

    def test_the_name_without_its_extension_is_the_same_name(self):
        hit = resolve.resolve_document("brandschutzkonzept")
        assert isinstance(hit, resolve.ResolvedDocument)
        assert hit.file_name == "Brandschutzkonzept.pdf"

    def test_a_partial_name_matching_two_files_is_a_question(self):
        """The whole point: two Grundrisse are an ambiguity, not a ranking."""
        refused = resolve.resolve_document("Grundriss")
        assert isinstance(refused, resolve.Refusal)
        assert "Mehrdeutig" in refused.message
        assert "Grundriss EG.pdf" in refused.message and "Grundriss OG.pdf" in refused.message

    def test_a_name_nobody_has_is_refused_with_an_instruction(self):
        refused = resolve.resolve_document("Statikbericht.pdf")
        assert isinstance(refused, resolve.Refusal)
        assert "Nicht gefunden" in refused.message
        assert "rate nicht" in refused.message

    def test_the_platform_corpus_and_this_chats_attachments_are_not_organisable(self):
        for name in ("OIB-RL2.pdf", "Anhang.pdf"):
            assert isinstance(resolve.resolve_document(name), resolve.Refusal)

    def test_the_folder_tree_includes_the_ancestors_of_a_filed_path(self):
        """`Einreichung` has no file of its own; it is still a folder."""
        assert resolve.known_folders() == ["Einreichung", "Einreichung/Pläne", "Nachweise"]

    def test_a_folder_can_be_named_by_its_last_segment(self):
        assert resolve.resolve_folder("pläne") == "Einreichung/Pläne"

    def test_the_project_root_has_several_names_and_one_value(self):
        for spelling in ("", "/", "Projektstamm", "root"):
            assert resolve.resolve_folder(spelling) == ""

    def test_an_unknown_folder_names_the_ones_that_exist(self):
        refused = resolve.resolve_folder("Fotos")
        assert isinstance(refused, resolve.Refusal)
        assert "Einreichung" in refused.message and "create_folder" in refused.message


# ── The tools: a card, and a result that cannot be read as success ───────────


class TestProposalsNeverWrite:
    async def test_a_move_emits_one_card_and_claims_nothing(self, registry):
        result = await _move(document="Brandschutzkonzept.pdf", target_folder="Einreichung")

        (card,) = registry.snapshot()
        assert card["type"] == "file_operation_proposal"
        assert card["operation"] == "move"
        assert card["operations"] == [
            {
                "document": "Brandschutzkonzept.pdf",
                "source": "projekt",
                "current": "Nachweise",
                "target_folder": "Einreichung",
            }
        ]
        assert "NOCH NICHTS geändert" in result
        assert "sage nicht, dass es erledigt ist" in result

    async def test_several_moves_land_on_one_card(self, registry):
        """„Räum die Einreichunterlagen zusammen" is one decision, not four."""
        await _move(document="Brandschutzkonzept.pdf", target_folder="Einreichung")
        await _move(document="Grundriss OG.pdf", target_folder="Einreichung")

        (card,) = registry.snapshot()
        assert [item["document"] for item in card["operations"]] == [
            "Brandschutzkonzept.pdf",
            "Grundriss OG.pdf",
        ]

    async def test_a_different_operation_opens_its_own_card(self, registry):
        """A move and a rename are two decisions and must be answerable apart."""
        await _move(document="Grundriss OG.pdf", target_folder="Einreichung")
        await _call(
            rename_document,
            RenameDocumentConfig(),
            document="Grundriss OG.pdf",
            new_display_name="Grundriss Obergeschoss",
        )

        assert [card["operation"] for card in registry.snapshot()] == ["move", "rename"]

    async def test_the_card_stops_at_the_cap(self, registry):
        """Past the cap a proposal is not a decision anyone reads before answering."""
        from aiq_agent.cards.models import MAX_FILE_OPERATIONS

        for _ in range(MAX_FILE_OPERATIONS + 2):
            await _move(document="Grundriss OG.pdf", target_folder="Einreichung")

        cards = registry.snapshot()
        assert len(cards[0]["operations"]) == MAX_FILE_OPERATIONS
        assert len(cards) == 2

    async def test_a_move_that_changes_nothing_is_not_proposed(self, registry):
        result = await _move(document="Grundriss EG.pdf", target_folder="Einreichung/Pläne")
        assert registry.snapshot() == []
        assert "liegt bereits" in result

    async def test_an_unresolvable_name_proposes_nothing(self, registry):
        result = await _move(document="Grundriss", target_folder="Einreichung")
        assert registry.snapshot() == []
        assert "Mehrdeutig" in result

    async def test_a_missing_folder_is_refused_rather_than_created(self, registry):
        """A move must never invent the folder it moves into."""
        result = await _move(document="Grundriss OG.pdf", target_folder="Fotos")
        assert registry.snapshot() == []
        assert "create_folder" in result

    async def test_a_new_folder_carries_its_parent_and_its_full_path(self, registry):
        result = await _call(create_folder, CreateFolderConfig(), name="Fotos", parent="Einreichung")

        (card,) = registry.snapshot()
        assert card["operation"] == "create_folder"
        assert card["operations"][0]["folder_name"] == "Fotos"
        assert card["operations"][0]["parent_folder"] == "Einreichung"
        assert "Einreichung/Fotos" in result

    async def test_a_folder_name_is_one_segment(self, registry):
        result = await _call(create_folder, CreateFolderConfig(), name="Einreichung/Fotos")
        assert registry.snapshot() == []
        assert "ohne Schrägstriche" in result

    async def test_a_folder_that_exists_is_not_proposed_again(self, registry):
        result = await _call(create_folder, CreateFolderConfig(), name="Pläne", parent="Einreichung")
        assert registry.snapshot() == []
        assert "gibt es bereits" in result

    async def test_an_assignment_carries_the_person_as_the_user_named_them(self, registry):
        """This tier has no member roster; the reader's session resolves it."""
        result = await _call(assign_document, AssignDocumentConfig(), document="Grundriss OG.pdf", member="Anna Berger")
        (card,) = registry.snapshot()
        assert card["operations"][0]["member"] == "Anna Berger"
        assert "NOCH NICHTS geändert" in result


class TestRefusals:
    async def test_a_chat_without_a_project_has_nothing_to_organise(self, monkeypatch, registry):
        monkeypatch.setattr(pc, "get_project_id_from_context", lambda: None)
        result = await _move(document="Grundriss OG.pdf", target_folder="Einreichung")
        assert registry.snapshot() == []
        assert "keinem Projekt" in result and "Nicht erneut versuchen" in result

    async def test_a_run_with_no_card_channel_says_so_instead_of_succeeding(self):
        """No registry bound (a CLI run, an eval): the proposal was never shown."""
        result = await _move(document="Grundriss OG.pdf", target_folder="Einreichung")
        assert "konnte also nicht" in result
        assert "Es wurde nichts geändert" in result

    async def test_a_turn_that_sees_no_files_says_that_instead_of_guessing(self, registry):
        set_turn_documents(None)
        result = await _move(document="Grundriss OG.pdf", target_folder="Einreichung")
        assert registry.snapshot() == []
        assert "keine Projekt- oder Büroarchiv-Dateien" in result
