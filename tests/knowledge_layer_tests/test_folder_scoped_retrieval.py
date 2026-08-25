"""Scoping `knowledge_search` to a project folder — and to its subtree (ADR-0049).

The folder is resolved from ``document_metadata.folder_path`` at retrieve time,
not read out of chunk metadata, for the same reason ``doc_class`` and
``display_title`` are: a rename must apply with nothing re-ingested. These tests
pin the boundary (``Brandschutz`` covers ``Brandschutz/Fluchtwege`` but never
``Brandschutzkonzepte``), the fail-open behaviour when the store is unreachable,
and the ``Ordner:`` line that lets a cited passage say where its document lives.
"""

from __future__ import annotations

from types import SimpleNamespace

from sources.knowledge_layer.src.register import _KNOWLEDGE_SEARCH_DESCRIPTION
from sources.knowledge_layer.src.register import _apply_agent_filters
from sources.knowledge_layer.src.register import _empty_search_message
from sources.knowledge_layer.src.register import _folder_matches
from sources.knowledge_layer.src.register import _format_results


def _chunk(file_name: str, collection: str = "proj_abc") -> SimpleNamespace:
    return SimpleNamespace(
        chunk_id=f"{file_name}-1",
        file_name=file_name,
        content="Fluchtwege sind freizuhalten.",
        score=0.9,
        page_number=3,
        content_type=SimpleNamespace(value="text"),
        metadata={"collection": collection},
    )


def _folders(monkeypatch, mapping: dict[str, str]) -> None:
    """Stub the batched store read the folder filter and the Ordner line use."""
    monkeypatch.setattr(
        "aiq_agent.knowledge.factory.get_document_folder_paths",
        lambda collection, file_names: {k: v for k, v in mapping.items() if k in file_names},
    )


class TestFolderMatch:
    """A path, not an id — so the subtree is a prefix, with a `/` boundary."""

    def test_the_folder_itself_matches(self) -> None:
        assert _folder_matches("Brandschutz", "Brandschutz") is True

    def test_a_subfolder_matches(self) -> None:
        assert _folder_matches("Brandschutz/Fluchtwege", "Brandschutz") is True

    def test_a_deeper_subfolder_matches(self) -> None:
        assert _folder_matches("Brandschutz/Fluchtwege/EG", "Brandschutz") is True

    def test_a_sibling_that_merely_starts_with_the_name_does_not(self) -> None:
        # The whole reason the boundary is `/` and not a bare startswith.
        assert _folder_matches("Brandschutzkonzepte", "Brandschutz") is False

    def test_a_parent_does_not_match_a_request_for_its_child(self) -> None:
        assert _folder_matches("Brandschutz", "Brandschutz/Fluchtwege") is False

    def test_a_document_at_the_root_matches_no_folder(self) -> None:
        assert _folder_matches(None, "Brandschutz") is False

    def test_matching_is_case_insensitive_and_slash_tolerant(self) -> None:
        # The agent retypes the folder out of the inventory; a capital letter or
        # a stray slash is not a different folder.
        assert _folder_matches("Brandschutz/Fluchtwege", "brandschutz") is True
        assert _folder_matches("Brandschutz", "/Brandschutz/") is True


class TestFolderFilter:
    """`folder=` narrows the merged candidate list, post-merge like its siblings."""

    def test_it_keeps_only_what_is_filed_in_the_folder_or_beneath_it(self, monkeypatch) -> None:
        chunks = [_chunk("in.pdf"), _chunk("nested.pdf"), _chunk("elsewhere.pdf"), _chunk("root.pdf")]
        _folders(
            monkeypatch,
            {
                "in.pdf": "Brandschutz",
                "nested.pdf": "Brandschutz/Fluchtwege",
                "elsewhere.pdf": "Statik",
            },
        )

        kept = _apply_agent_filters(chunks, doc_class=None, title_contains=None, folder="Brandschutz")

        assert [c.file_name for c in kept] == ["in.pdf", "nested.pdf"]

    def test_a_sibling_folder_with_a_shared_prefix_is_not_swept_in(self, monkeypatch) -> None:
        chunks = [_chunk("in.pdf"), _chunk("sibling.pdf")]
        _folders(monkeypatch, {"in.pdf": "Brandschutz", "sibling.pdf": "Brandschutzkonzepte"})

        kept = _apply_agent_filters(chunks, doc_class=None, title_contains=None, folder="Brandschutz")

        assert [c.file_name for c in kept] == ["in.pdf"]

    def test_omitting_the_folder_leaves_every_hit_alone(self, monkeypatch) -> None:
        chunks = [_chunk("in.pdf"), _chunk("root.pdf")]
        _folders(monkeypatch, {"in.pdf": "Brandschutz"})

        kept = _apply_agent_filters(chunks, doc_class=None, title_contains=None, folder=None)

        assert [c.file_name for c in kept] == ["in.pdf", "root.pdf"]

    def test_it_combines_with_the_other_agent_filters(self, monkeypatch) -> None:
        chunks = [_chunk("plan.pdf"), _chunk("schnitt.pdf")]
        _folders(monkeypatch, {"plan.pdf": "Brandschutz", "schnitt.pdf": "Brandschutz"})

        kept = _apply_agent_filters(
            chunks,
            doc_class=None,
            title_contains="plan",
            folder="Brandschutz",
        )

        assert [c.file_name for c in kept] == ["plan.pdf"]

    def test_an_unreachable_store_drops_everything_rather_than_answering_wrongly(self, monkeypatch) -> None:
        # Fail-open on the READ (empty map), fail-closed on the ANSWER: a folder
        # question whose filing cannot be read must return nothing, so the model
        # is told to retry, rather than a shelf-wide result presented as "the
        # documents in Brandschutz".
        def _boom(collection, file_names):
            raise RuntimeError("store down")

        monkeypatch.setattr("aiq_agent.knowledge.factory.get_document_folder_paths", _boom)

        kept = _apply_agent_filters([_chunk("in.pdf")], doc_class=None, title_contains=None, folder="Brandschutz")

        assert kept == []


class TestFolderReachesTheModel:
    """What the agent is told: the parameter, the miss, and where a hit lives."""

    def test_the_tool_description_offers_the_folder_parameter(self) -> None:
        assert "`folder=`" in _KNOWLEDGE_SEARCH_DESCRIPTION
        assert "Ordner" in _KNOWLEDGE_SEARCH_DESCRIPTION

    def test_an_empty_folder_scoped_search_names_the_folder_and_the_way_out(self) -> None:
        message = _empty_search_message("Fluchtwege", folder="Brandschutz")
        assert "folder='Brandschutz'" in message
        assert "drop `folder=`" in message
        assert "Do not invent a citation." in message

    def test_a_hit_states_the_folder_its_document_is_filed_in(self, monkeypatch) -> None:
        _folders(monkeypatch, {"plan.pdf": "Brandschutz/Fluchtwege"})
        result = SimpleNamespace(success=True, chunks=[_chunk("plan.pdf")])

        rendered = _format_results(result, "Fluchtwege")

        assert "Ordner: Brandschutz/Fluchtwege" in rendered

    def test_a_document_at_the_root_gets_no_ordner_line_at_all(self, monkeypatch) -> None:
        # Absence must read as absence. An "Ordner: /" or "Ordner: -" would be a
        # folder the user never made.
        _folders(monkeypatch, {})
        result = SimpleNamespace(success=True, chunks=[_chunk("plan.pdf")])

        rendered = _format_results(result, "Fluchtwege")

        assert "Ordner:" not in rendered
