"""The conversation-scoped "already read" digest: append, dedupe, cap, evict, render.

A digest line is ``"<file> | <collection> | Seiten <p> | Punkte <n> | Turn <k>"``:
one per document this conversation opened, merged at turn end from the turn's
captures. These tests pin the pure merge/parse/render contract; the graph
wiring (persist, lift, forward) lives in
``conversation/test_already_read_digest.py``.
"""

from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.knowledge.already_read import DIGEST_HEADING
from aiq_agent.knowledge.already_read import MAX_DIGEST_DOCS
from aiq_agent.knowledge.already_read import MAX_DIGEST_TOKENS
from aiq_agent.knowledge.already_read import estimate_tokens
from aiq_agent.knowledge.already_read import format_digest_line
from aiq_agent.knowledge.already_read import merge_digest
from aiq_agent.knowledge.already_read import parse_digest_line
from aiq_agent.knowledge.already_read import render_already_read_block


def _entry(
    citation_key: str,
    *,
    collection: str = "oib_knowledge",
    punkt: str | None = None,
    tool_name: str = "knowledge_search",
) -> SourceEntry:
    return SourceEntry(
        citation_key=citation_key,
        title="Titel",
        source_type="knowledge_layer",
        tool_name=tool_name,
        collection=collection,
        shelf="base",
        punkt=punkt,
        chunk_text="Die Fluchtweglänge darf 40 m nicht überschreiten.",
    )


class TestAppend:
    def test_a_first_capture_becomes_a_line(self):
        lines = merge_digest(None, [_entry("oib-rl_2_ausgabe_mai_2023.pdf, p.12", punkt="3.5.2")], turn=1)

        assert lines == ["oib-rl_2_ausgabe_mai_2023.pdf | oib_knowledge | Seiten 12 | Punkte 3.5.2 | Turn 1"]

    def test_a_second_turn_appends_its_document(self):
        previous = ["oib-rl_2_ausgabe_mai_2023.pdf | oib_knowledge | Seiten 12 | Punkte 3.5.2 | Turn 1"]

        lines = merge_digest(previous, [_entry("oib-rl_3_ausgabe_mai_2023.pdf, p.4")], turn=2)

        assert lines == [
            "oib-rl_2_ausgabe_mai_2023.pdf | oib_knowledge | Seiten 12 | Punkte 3.5.2 | Turn 1",
            "oib-rl_3_ausgabe_mai_2023.pdf | oib_knowledge | Seiten 4 | Punkte - | Turn 2",
        ]

    def test_a_page_without_a_punkt_and_vice_versa(self):
        lines = merge_digest(
            None,
            [
                _entry("plan.pdf, p.1"),
                _entry("oib-rl_2_ausgabe_mai_2023.pdf, p.12", punkt="3.5.2"),
            ],
            turn=1,
        )

        assert lines == [
            "plan.pdf | oib_knowledge | Seiten 1 | Punkte - | Turn 1",
            "oib-rl_2_ausgabe_mai_2023.pdf | oib_knowledge | Seiten 12 | Punkte 3.5.2 | Turn 1",
        ]

    def test_nothing_digestible_is_absent_not_empty(self):
        assert merge_digest(None, [], turn=1) is None
        assert merge_digest([], [], turn=3) is None


class TestDedupe:
    def test_two_pages_of_one_document_are_one_line(self):
        lines = merge_digest(
            None,
            [
                _entry("oib-rl_2_ausgabe_mai_2023.pdf, p.12", punkt="3.5.2"),
                _entry("oib-rl_2_ausgabe_mai_2023.pdf, p.30", punkt="4.1"),
            ],
            turn=2,
        )

        assert lines == ["oib-rl_2_ausgabe_mai_2023.pdf | oib_knowledge | Seiten 12, 30 | Punkte 3.5.2, 4.1 | Turn 2"]

    def test_the_same_passage_twice_counts_once(self):
        capture = _entry("oib-rl_2_ausgabe_mai_2023.pdf, p.12", punkt="3.5.2")

        assert merge_digest(None, [capture, capture], turn=1) == [
            "oib-rl_2_ausgabe_mai_2023.pdf | oib_knowledge | Seiten 12 | Punkte 3.5.2 | Turn 1"
        ]

    def test_the_same_filename_in_two_collections_is_two_documents(self):
        lines = merge_digest(
            None,
            [
                _entry("Plan.pdf, p.1", collection="proj_abc"),
                _entry("Plan.pdf, p.1", collection="archiv_all"),
            ],
            turn=1,
        )

        assert len(lines) == 2
        assert lines[0].startswith("Plan.pdf | proj_abc |")
        assert lines[1].startswith("Plan.pdf | archiv_all |")

    def test_dedupe_ignores_case(self):
        lines = merge_digest(
            ["Plan.pdf | proj_abc | Seiten 1 | Punkte - | Turn 1"],
            [_entry("plan.pdf, p.2", collection="proj_abc")],
            turn=2,
        )

        assert lines == ["Plan.pdf | proj_abc | Seiten 1, 2 | Punkte - | Turn 2"]

    def test_a_reread_updates_the_turn_and_moves_to_the_end(self):
        previous = [
            "a.pdf | oib_knowledge | Seiten 1 | Punkte - | Turn 1",
            "b.pdf | oib_knowledge | Seiten 2 | Punkte - | Turn 2",
        ]

        lines = merge_digest(previous, [_entry("a.pdf, p.9")], turn=5)

        assert lines == [
            "b.pdf | oib_knowledge | Seiten 2 | Punkte - | Turn 2",
            "a.pdf | oib_knowledge | Seiten 1, 9 | Punkte - | Turn 5",
        ]

    def test_non_documents_never_become_lines(self):
        bare = SourceEntry(source_type="tool_result", tool_name="some_tool")
        web = SourceEntry(url="https://example.gv.at/hinweis", title="Hinweis", source_type="generic")

        assert merge_digest(None, [bare, web], turn=1) is None


class TestCap:
    def test_the_document_cap_evicts_the_oldest(self):
        captures = [_entry(f"doc_{index:02d}.pdf, p.1") for index in range(MAX_DIGEST_DOCS + 1)]

        lines = merge_digest(None, captures, turn=1)

        assert lines is not None
        assert len(lines) == MAX_DIGEST_DOCS
        assert lines[0].startswith("doc_01.pdf |")
        assert lines[-1].startswith(f"doc_{MAX_DIGEST_DOCS:02d}.pdf |")

    def test_the_token_cap_evicts_the_oldest_and_keeps_the_newest(self):
        def long_name(index: int) -> str:
            return f"{'lange_datei_' * 20}{index:02d}.pdf"

        captures = [_entry(f"{long_name(index)}, p.1") for index in range(MAX_DIGEST_DOCS)]

        lines = merge_digest(None, captures, turn=1)

        assert lines is not None
        assert sum(estimate_tokens(line) for line in lines) <= MAX_DIGEST_TOKENS
        assert lines[-1].startswith(long_name(MAX_DIGEST_DOCS - 1))


class TestParse:
    def test_format_round_trips(self):
        line = format_digest_line("a.pdf", "proj_1", {3, 1}, {"4.1", "3.5.2"}, 7)

        parsed = parse_digest_line(line)

        assert parsed is not None
        assert (parsed.file_name, parsed.collection, parsed.turn) == ("a.pdf", "proj_1", 7)
        assert parsed.pages == {1, 3}
        assert parsed.punkts == {"3.5.2", "4.1"}

    def test_malformed_lines_are_skipped_not_fatal(self):
        bad_lines = (
            "",
            "a.pdf",
            "a | b | c",
            "a.pdf | c | Seiten x | Punkte - | Turn 1",
            "a.pdf | c | Seiten 1 | Punkte - | Turn x",
        )
        for bad in bad_lines:
            assert parse_digest_line(bad) is None

        lines = merge_digest(["nonsense", *["a.pdf | c | Seiten 1 | Punkte - | Turn 1"]], [], turn=2)

        assert lines == ["a.pdf | c | Seiten 1 | Punkte - | Turn 1"]


class TestRender:
    def test_the_block_names_the_heading_and_the_entries(self):
        block = render_already_read_block(["a.pdf | c | Seiten 1 | Punkte - | Turn 1"])

        assert DIGEST_HEADING in block
        assert "- a.pdf | c | Seiten 1 | Punkte - | Turn 1" in block

    def test_the_block_carries_the_index_not_evidence_rule_and_the_bound(self):
        block = render_already_read_block(["a.pdf | c | Seiten 1 | Punkte - | Turn 1"])

        assert "KEIN Beleg" in block
        assert "read_passage" in block
        assert str(MAX_DIGEST_DOCS) in block
        assert str(MAX_DIGEST_TOKENS) in block

    def test_no_digest_renders_no_section(self):
        assert render_already_read_block(None) == ""
        assert render_already_read_block([]) == ""
