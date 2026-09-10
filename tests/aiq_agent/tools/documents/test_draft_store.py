"""The working directory's storage half: what it normalises, bounds and keeps apart.

Every test here runs the REAL DeepAgents ``StoreBackend`` over an
``InMemoryStore``, because the properties under test are properties of the pair
— the stock create-only write and exact-string edit, plus the three things this
repo adds on top (NFC, a byte ceiling, one namespace per conversation).
"""

from __future__ import annotations

import unicodedata

import pytest
from langgraph.store.memory import InMemoryStore

from aiq_agent.tools.documents import draft_store
from aiq_agent.tools.documents.draft_store import DRAFT_ROOT
from aiq_agent.tools.documents.draft_store import MAX_DRAFT_BYTES
from aiq_agent.tools.documents.draft_store import VERSION_KEY
from aiq_agent.tools.documents.draft_store import DraftBackend
from aiq_agent.tools.documents.draft_store import draft_namespace
from aiq_agent.tools.documents.draft_store import get_draft_backend
from aiq_agent.tools.documents.draft_store import get_draft_store
from aiq_agent.tools.documents.draft_store import normalize_draft_text
from aiq_agent.tools.documents.draft_store import reset_draft_stores

#: The same word typed the two ways a keyboard and a model produce it.
COMPOSED = unicodedata.normalize("NFC", "Gebäudeklasse 4")
DECOMPOSED = unicodedata.normalize("NFD", "Gebäudeklasse 4")

DRAFT = f"{DRAFT_ROOT}aktenvermerk.md"


@pytest.fixture
def backend() -> DraftBackend:
    return DraftBackend(store=InMemoryStore(), conversation_id="conv-1")


def stored(backend: DraftBackend, path: str = DRAFT) -> dict:
    item = backend._get_store().get(draft_namespace(backend.conversation_id), path)
    assert item is not None
    return item.value


class TestNfc:
    """The one correction this repo makes to the stock backend."""

    def test_the_two_spellings_are_not_the_same_bytes(self) -> None:
        """Without this the rest of the class is testing nothing."""
        assert COMPOSED != DECOMPOSED
        assert len(COMPOSED) < len(DECOMPOSED)

    def test_stored_content_is_composed(self, backend: DraftBackend) -> None:
        backend.write(DRAFT, f"# Vermerk\n\n{DECOMPOSED}\n")
        assert stored(backend)["content"] == f"# Vermerk\n\n{COMPOSED}\n"

    def test_a_decomposed_old_string_still_finds_composed_text(self, backend: DraftBackend) -> None:
        """The failure this exists for: an error printing a string identical to the file's.

        The model types ``Gebäudeklasse`` decomposed against a file written
        composed, DeepAgents reports ``String not found in file:
        'Gebäudeklasse 4'``, and the model retries the same bytes forever.
        """
        backend.write(DRAFT, f"# Vermerk\n\n{COMPOSED}\n")
        result = backend.edit(DRAFT, DECOMPOSED, "Gebäudeklasse 5")
        assert result.error is None
        assert result.occurrences == 1
        assert "Gebäudeklasse 5" in stored(backend)["content"]

    def test_a_decomposed_new_string_lands_composed(self, backend: DraftBackend) -> None:
        backend.write(DRAFT, "# Vermerk\n\nPlatzhalter\n")
        backend.edit(DRAFT, "Platzhalter", DECOMPOSED)
        assert stored(backend)["content"].endswith(f"{COMPOSED}\n")

    def test_normalisation_leaves_empty_text_alone(self) -> None:
        assert normalize_draft_text("") == ""


class TestTheCeiling:
    """A refusal, never a truncation: a shortened draft is a lie about what was written."""

    def test_a_write_past_the_ceiling_is_refused_with_a_readable_reason(self, backend: DraftBackend) -> None:
        result = backend.write(DRAFT, "x" * (MAX_DRAFT_BYTES + 1))
        assert result.error is not None
        assert f"{MAX_DRAFT_BYTES // 1024} KB" in result.error
        assert "Shorten the document" in result.error

    def test_a_refused_write_stores_nothing(self, backend: DraftBackend) -> None:
        backend.write(DRAFT, "x" * (MAX_DRAFT_BYTES + 1))
        assert backend._get_store().get(draft_namespace("conv-1"), DRAFT) is None

    def test_the_ceiling_is_the_whole_conversation_not_one_file(self, backend: DraftBackend) -> None:
        half = "x" * (MAX_DRAFT_BYTES // 2)
        assert backend.write(f"{DRAFT_ROOT}a.md", half).error is None
        assert backend.write(f"{DRAFT_ROOT}b.md", half).error is None
        assert backend.write(f"{DRAFT_ROOT}c.md", half).error is not None

    def test_replacing_a_file_counts_only_the_difference(self, backend: DraftBackend) -> None:
        """A rewrite is not an addition; the old bytes go away with it."""
        big = "x" * (MAX_DRAFT_BYTES - 10)
        assert backend.write(f"{DRAFT_ROOT}a.md", big).error is None
        # `write` is create-only, so the same-size rewrite arrives as an edit.
        assert backend.edit(f"{DRAFT_ROOT}a.md", big, "y" * (MAX_DRAFT_BYTES - 10)).error is None

    def test_an_edit_that_would_grow_past_the_ceiling_is_refused(self, backend: DraftBackend) -> None:
        backend.write(DRAFT, "x" * (MAX_DRAFT_BYTES - 100))
        result = backend.edit(DRAFT, "x" * 50, "y" * 200)
        assert result.error is not None
        assert "would exceed its" in result.error

    def test_an_edit_that_shrinks_is_never_refused(self, backend: DraftBackend) -> None:
        backend.write(DRAFT, "# Vermerk\n\n" + "x" * (MAX_DRAFT_BYTES - 100))
        assert backend.edit(DRAFT, "# Vermerk", "# V").error is None

    def test_a_multibyte_draft_is_measured_in_bytes(self, backend: DraftBackend) -> None:
        """Two bytes per umlaut: a ceiling counted in characters would be 30% wrong."""
        result = backend.write(DRAFT, "ä" * (MAX_DRAFT_BYTES // 2 + 1))
        assert result.error is not None


class TestThePathRoot:
    def test_a_write_outside_the_root_is_refused(self, backend: DraftBackend) -> None:
        result = backend.write("/etc/passwd", "x")
        assert result.error is not None
        assert DRAFT_ROOT in result.error

    def test_traversal_out_of_the_root_is_refused(self, backend: DraftBackend) -> None:
        assert backend.write(f"{DRAFT_ROOT}../secrets.md", "x").error is not None

    def test_an_edit_outside_the_root_is_refused(self, backend: DraftBackend) -> None:
        assert backend.edit("/etc/passwd", "a", "b").error is not None


class TestTheStockContract:
    """What DeepAgents already guarantees, pinned because the prompt relies on it."""

    def test_write_is_create_only(self, backend: DraftBackend) -> None:
        backend.write(DRAFT, "# Vermerk\n")
        result = backend.write(DRAFT, "# Anderer Vermerk\n")
        assert result.error is not None
        assert "already exists" in result.error

    def test_an_ambiguous_edit_reports_the_count(self, backend: DraftBackend) -> None:
        """The count is what tells the model to add surrounding context."""
        backend.write(DRAFT, "Frist\nFrist\nFrist\n")
        result = backend.edit(DRAFT, "Frist", "Termin")
        assert result.error is not None
        assert "appears 3 times" in result.error

    def test_a_missing_string_says_so(self, backend: DraftBackend) -> None:
        backend.write(DRAFT, "# Vermerk\n")
        assert "String not found in file" in (backend.edit(DRAFT, "Frist", "Termin").error or "")

    def test_editing_a_file_that_does_not_exist_says_so(self, backend: DraftBackend) -> None:
        assert "not found" in (backend.edit(DRAFT, "a", "b").error or "")


class TestNamespaceIsolation:
    def test_two_conversations_never_see_each_other(self) -> None:
        store = InMemoryStore()
        first = DraftBackend(store=store, conversation_id="conv-1")
        second = DraftBackend(store=store, conversation_id="conv-2")

        first.write(DRAFT, "# Vermerk aus Unterhaltung 1\n")

        assert second.read(DRAFT).error is not None
        assert second.ls(DRAFT_ROOT).entries == []
        assert first.ls(DRAFT_ROOT).entries != []

    def test_the_same_path_in_two_conversations_holds_two_documents(self) -> None:
        store = InMemoryStore()
        first = DraftBackend(store=store, conversation_id="conv-1")
        second = DraftBackend(store=store, conversation_id="conv-2")

        first.write(DRAFT, "# Eins\n")
        assert second.write(DRAFT, "# Zwei\n").error is None
        assert stored(first)["content"] == "# Eins\n"
        assert stored(second)["content"] == "# Zwei\n"

    def test_the_namespace_is_the_conversation(self) -> None:
        assert draft_namespace("conv-1") == ("conversation", "conv-1", "drafts")


class TestTheVersionCounter:
    """What the draft card counts: writes and edits of one path, in one conversation."""

    def test_a_first_write_is_version_one(self, backend: DraftBackend) -> None:
        backend.write(DRAFT, "# Vermerk\n")
        assert stored(backend)[VERSION_KEY] == 1

    def test_every_edit_advances_it(self, backend: DraftBackend) -> None:
        backend.write(DRAFT, "# Vermerk\n\nPunkt 3\n")
        backend.edit(DRAFT, "Punkt 3", "Punkt 3 (gekürzt)")
        backend.edit(DRAFT, "gekürzt", "gestrichen")
        assert stored(backend)[VERSION_KEY] == 3

    def test_a_refused_edit_does_not_advance_it(self, backend: DraftBackend) -> None:
        backend.write(DRAFT, "# Vermerk\n")
        backend.edit(DRAFT, "gibt es nicht", "x")
        assert stored(backend)[VERSION_KEY] == 1

    def test_the_counter_does_not_reach_the_file_tools(self, backend: DraftBackend) -> None:
        """It rides on the stored value; ``read_file`` still returns the document."""
        backend.write(DRAFT, "# Vermerk\n")
        result = backend.read(DRAFT)
        assert result.error is None
        assert result.file_data["content"] == "# Vermerk\n"


class TestTheAsyncHalf:
    """The path Piloti actually runs: ToolNode awaits the coroutine."""

    @pytest.mark.asyncio
    async def test_write_and_edit_normalise_and_count(self, backend: DraftBackend) -> None:
        assert (await backend.awrite(DRAFT, f"# Vermerk\n\n{DECOMPOSED}\n")).error is None
        result = await backend.aedit(DRAFT, DECOMPOSED, "Gebäudeklasse 5")
        assert result.error is None
        assert stored(backend)[VERSION_KEY] == 2

    @pytest.mark.asyncio
    async def test_the_ceiling_holds_on_the_async_path(self, backend: DraftBackend) -> None:
        assert (await backend.awrite(DRAFT, "x" * (MAX_DRAFT_BYTES + 1))).error is not None

    @pytest.mark.asyncio
    async def test_the_root_holds_on_the_async_path(self, backend: DraftBackend) -> None:
        assert (await backend.awrite("/etc/passwd", "x")).error is not None


class TestTheStoreFactory:
    @pytest.fixture(autouse=True)
    def _clear(self):
        reset_draft_stores()
        yield
        reset_draft_stores()

    @pytest.mark.asyncio
    async def test_a_non_postgres_dsn_falls_back_to_memory(self, caplog) -> None:
        with caplog.at_level("WARNING"):
            store = await get_draft_store("./checkpoints.db")
        assert isinstance(store, InMemoryStore)
        assert "do not survive a restart" in caplog.text

    @pytest.mark.asyncio
    async def test_the_store_is_built_once_per_process(self) -> None:
        first = await get_draft_store("./checkpoints.db")
        second = await get_draft_store("./checkpoints.db")
        assert first is second

    @pytest.mark.asyncio
    async def test_a_postgres_dsn_takes_the_postgres_store(self, monkeypatch) -> None:
        """Neither a pool nor a database, only the branch: the DSN decides."""
        built: dict[str, str] = {}

        class _FakeStore:
            def __init__(self, pool) -> None:
                built["pool"] = pool

            async def setup(self) -> None:
                built["setup"] = "ran"

        monkeypatch.setattr(draft_store, "is_postgres_dsn", lambda _dsn: True)
        monkeypatch.setitem(
            __import__("sys").modules,
            "langgraph.store.postgres",
            type("_M", (), {"AsyncPostgresStore": _FakeStore}),
        )
        monkeypatch.setattr("aiq_agent.common.get_checkpoint_pool", lambda dsn: f"pool:{dsn}")

        store = await get_draft_store("postgresql://x/y")
        assert isinstance(store, _FakeStore)
        assert built == {"pool": "pool:postgresql://x/y", "setup": "ran"}

    @pytest.mark.asyncio
    async def test_the_backend_is_pinned_to_one_conversation(self) -> None:
        backend = await get_draft_backend("conv-9", "./checkpoints.db")
        assert backend.conversation_id == "conv-9"
        assert backend._get_namespace() == ("conversation", "conv-9", "drafts")
