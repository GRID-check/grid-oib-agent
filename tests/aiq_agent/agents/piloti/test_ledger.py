"""The read-but-uncited channel: what the turn read beyond what it cited.

``ledger.assemble_result`` threads ``read_sources`` — one entry per retrieved
but uncited DOCUMENT (document key + lane/kind + page, NO prose) — onto the
finished state, where ``conversation.ANSWER_LIFTS`` and ``turn.response``
carry it to the wire for the "Gelesen, nicht zitiert" disclosure.
"""

from langchain_core.messages import AIMessage

from aiq_agent.agents.piloti.answer_pipeline import CitedSource
from aiq_agent.agents.piloti.answer_pipeline import FinalAnswer
from aiq_agent.agents.piloti.ledger import assemble_result
from aiq_agent.agents.piloti.ledger import read_but_uncited
from aiq_agent.common.citation_verification import SourceEntry


def _kb(
    citation_key: str,
    *,
    collection: str = "oib_knowledge",
    doc_class: str | None = "oib_richtlinie",
    tool_name: str = "knowledge_tool",
) -> SourceEntry:
    return SourceEntry(
        citation_key=citation_key,
        title="OIB-Richtlinie 2",
        source_type="knowledge_layer",
        tool_name=tool_name,
        collection=collection,
        shelf="base",
        doc_class=doc_class,
        chunk_text="Die Fluchtweglänge darf 40 m nicht überschreiten.",
    )


def _cited(entry: SourceEntry, number: int = 1) -> CitedSource:
    return CitedSource(entry=entry, number=number)


class TestReadButUncited:
    def test_a_cited_document_never_reappears_as_read(self):
        """The same document cited at p.12 is not "read" via its p.30 passage."""
        turn_sources = [_kb("oib-rl_2.pdf, p.12"), _kb("oib-rl_2.pdf, p.30")]
        cited = [_cited(_kb("oib-rl_2.pdf, p.12"))]
        assert read_but_uncited(turn_sources, cited) is None

    def test_an_uncited_document_is_listed_once_per_document(self):
        """Two pages of one uncited document are one disclosure entry."""
        wire = read_but_uncited([_kb("oib-rl_2.pdf, p.12"), _kb("oib-rl_2.pdf, p.30")], [])
        assert wire is not None
        assert len(wire) == 1
        assert wire[0]["page"] == 12

    def test_two_documents_are_two_entries(self):
        wire = read_but_uncited([_kb("oib-rl_2.pdf, p.12"), _kb("oib-rl_3.pdf, p.4")], [])
        assert wire is not None
        assert len(wire) == 2

    def test_same_filename_in_two_collections_is_two_documents(self):
        """The document identity is (collection, filename): a project Plan.pdf
        and an Archiv Plan.pdf are two documents, not one."""
        wire = read_but_uncited(
            [
                _kb("Plan.pdf, p.1", collection="proj_abc"),
                _kb("Plan.pdf, p.1", collection="archiv_all"),
            ],
            [],
        )
        assert wire is not None
        assert len(wire) == 2

    def test_a_bare_tool_result_identifies_nothing_and_is_dropped(self):
        """A source with neither citation key nor URL cannot be opened from a
        chip, so it must not become one."""
        bare = SourceEntry(source_type="tool_result", tool_name="some_tool")
        assert read_but_uncited([bare], []) is None

    def test_nothing_uncited_is_absent_not_empty(self):
        assert read_but_uncited([], []) is None

    def test_the_wire_carries_identity_and_placement_but_no_prose(self):
        wire = read_but_uncited([_kb("oib-rl_2.pdf, p.12")], [])
        assert wire is not None
        entry = wire[0]
        assert entry["document_id"] == "doc:oib_knowledge:oib-rl_2.pdf"
        assert entry["file_name"] == "oib-rl_2.pdf"
        assert entry["page"] == 12
        assert entry["kind"] == "baurecht"
        assert entry["lane"].startswith("baurecht")
        for prose in ("snippet", "content", "score", "punkt", "number", "binding_status"):
            assert prose not in entry, f"{prose} must not travel on the read-but-uncited channel"

    def test_a_web_source_keeps_its_url_identity(self):
        web = SourceEntry(
            url="https://example.gv.at/hinweis",
            title="Hinweis",
            source_type="generic",
            tool_name="web_search_tool",
        )
        wire = read_but_uncited([web], [])
        assert wire is not None
        assert wire[0]["url"] == "https://example.gv.at/hinweis"


class TestAssembleResultThreadsReadSources:
    def _final(self, **fields) -> FinalAnswer:
        return FinalAnswer(
            messages=[AIMessage(content="Die Antwort.")],
            answered=False,
            content="Die Antwort.",
            **fields,
        )

    def test_read_sources_reach_the_finished_state(self):
        state = assemble_result(
            {},
            self._final(),
            turn_sources=[_kb("oib-rl_2.pdf, p.12")],
            turn_measurements=[],
        )
        assert state.read_sources is not None
        assert state.read_sources[0]["file_name"] == "oib-rl_2.pdf"

    def test_a_fully_cited_turn_carries_no_field_at_all(self):
        entry = _kb("oib-rl_2.pdf, p.12")
        state = assemble_result(
            {},
            self._final(cited=(_cited(entry),)),
            turn_sources=[entry],
            turn_measurements=[],
        )
        assert state.read_sources is None
