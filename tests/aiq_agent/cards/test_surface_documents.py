"""Tests for the ``surface_documents`` tool helpers and the document cards."""

from types import SimpleNamespace
from unittest.mock import MagicMock

from aiq_agent.cards.models import grid_card_adapter
from aiq_agent.cards.surface_documents import _BRIEF_SNIPPET_MAX
from aiq_agent.cards.surface_documents import _CHUNK_TOP_K
from aiq_agent.cards.surface_documents import _TOOL_DESCRIPTION
from aiq_agent.cards.surface_documents import MAX_SURFACED_FILES
from aiq_agent.cards.surface_documents import MIN_SURFACE_SCORE
from aiq_agent.cards.surface_documents import SurfaceDocumentsConfig
from aiq_agent.cards.surface_documents import _aggregate_surfaced
from aiq_agent.cards.surface_documents import _briefing_for_agent
from aiq_agent.cards.surface_documents import _filename_mentioned_in_query
from aiq_agent.cards.surface_documents import _match_known_filename
from aiq_agent.cards.surface_documents import _source_for_collection
from aiq_agent.cards.surface_documents import _target_collections
from aiq_agent.cards.surface_documents import surface_documents


def _chunk(file_name, score, content="passage", page=1):
    return SimpleNamespace(file_name=file_name, score=score, content=content, page_number=page)


class TestSourceForCollection:
    def test_project_and_archiv_and_base(self):
        assert _source_for_collection("proj_abc") == "projekt"
        assert _source_for_collection("archiv_org1") == "buero"
        assert _source_for_collection("oib_knowledge") is None
        assert _source_for_collection("s_conversation") is None


class TestTargetCollections:
    def test_keeps_only_project_and_archiv_dedup_order(self):
        scope = ["oib_knowledge", "proj_a", "archiv_o", "proj_a", "s_x"]
        assert _target_collections(scope) == ["proj_a", "archiv_o"]

    def test_none_scope(self):
        assert _target_collections(None) == []

    def test_base_only_scope_yields_nothing(self):
        assert _target_collections(["oib_knowledge"]) == []

    def test_shelf_archiv_drops_project(self):
        scope = ["proj_a", "archiv_o", "oib_knowledge"]
        assert _target_collections(scope, shelf="archiv") == ["archiv_o"]

    def test_shelf_project_drops_archiv(self):
        scope = ["proj_a", "archiv_o"]
        assert _target_collections(scope, shelf="project") == ["proj_a"]

    def test_scoped_entries_use_the_stated_shelf_not_the_name(self):
        from aiq_agent.common.source_kinds import Shelf
        from aiq_agent.knowledge.scoping import ScopedCollection

        scoped = [
            ScopedCollection("custom_project_store", Shelf.PROJECT),
            ScopedCollection("custom_office_store", Shelf.ARCHIV),
            ScopedCollection("oib_knowledge", Shelf.BASE),
        ]
        assert _target_collections([], shelf="archiv", scoped=scoped) == ["custom_office_store"]
        assert _target_collections([], shelf="project", scoped=scoped) == ["custom_project_store"]
        assert _target_collections([], scoped=scoped) == ["custom_project_store", "custom_office_store"]


class TestNameResolution:
    def test_exact_and_casefold(self):
        known = ["Brandschutzplan_EG.pdf", "Schnitt.pdf"]
        assert _match_known_filename("Brandschutzplan_EG.pdf", known) == "Brandschutzplan_EG.pdf"
        assert _match_known_filename("brandschutzplan_eg.pdf", known) == "Brandschutzplan_EG.pdf"

    def test_query_that_names_a_file_is_that_file(self):
        known = ["Brandschutzplan_EG.pdf", "Schnitt.pdf"]
        assert _filename_mentioned_in_query("Was steht in Brandschutzplan_EG.pdf", known) == "Brandschutzplan_EG.pdf"
        assert _filename_mentioned_in_query("Fluchtwege allgemein", known) is None


class TestAggregateSurfaced:
    def test_mode_one_is_the_winner_only(self):
        hits = [
            (_chunk("a.pdf", 0.9, "best a", page=3), "projekt"),
            (_chunk("b.pdf", 0.88, "almost"), "projekt"),
            (_chunk("c.pdf", 0.5, "weak"), "buero"),
        ]
        out = _aggregate_surfaced(hits, MAX_SURFACED_FILES, mode="one")
        assert [d["file_name"] for d in out] == ["a.pdf"]
        assert out[0]["snippet"] == "best a"

    def test_mode_many_keeps_close_matches_drops_the_tail(self):
        hits = [
            (_chunk("a.pdf", 0.90), "projekt"),
            (_chunk("b.pdf", 0.86), "projekt"),
            (_chunk("c.pdf", 0.50), "projekt"),
        ]
        out = _aggregate_surfaced(hits, 12, mode="many")
        assert [d["file_name"] for d in out] == ["a.pdf", "b.pdf"]

    def test_mode_many_collapses_when_the_winner_is_clear(self):
        hits = [
            (_chunk("citationhealth.light.png", 0.88), "projekt"),
            (_chunk("image.png", 0.61), "projekt"),
            (_chunk("Haus.ifc", 0.60), "projekt"),
        ]
        out = _aggregate_surfaced(hits, 12, mode="many")
        assert [d["file_name"] for d in out] == ["citationhealth.light.png"]

    def test_mode_many_does_not_mix_images_with_ifc(self):
        hits = [
            (_chunk("citationhealth.light.png", 0.80), "projekt"),
            (_chunk("Haus.ifc", 0.79), "projekt"),
            (_chunk("Duplex.ifc", 0.78), "projekt"),
        ]
        out = _aggregate_surfaced(hits, 12, mode="many")
        assert [d["file_name"] for d in out] == ["citationhealth.light.png"]

    def test_query_hint_keeps_only_that_kind(self):
        hits = [
            (_chunk("citationhealth.light.png", 0.70), "projekt"),
            (_chunk("Brandschutz.pdf", 0.85), "projekt"),
            (_chunk("Haus.ifc", 0.84), "projekt"),
        ]
        out = _aggregate_surfaced(hits, 12, mode="many", query="citation health screenshot")
        assert [d["file_name"] for d in out] == ["citationhealth.light.png"]

    def test_mode_many_caps(self):
        hits = [(_chunk(f"f{i}.pdf", 0.90 - i * 0.005), "projekt") for i in range(20)]
        out = _aggregate_surfaced(hits, 12, mode="many")
        assert 1 <= len(out) <= MAX_SURFACED_FILES

    def test_drops_weak_matches_below_quality_floor(self):
        hits = [
            (_chunk("strong.pdf", MIN_SURFACE_SCORE + 0.1), "projekt"),
            (_chunk("weak.pdf", MIN_SURFACE_SCORE - 0.1), "projekt"),
        ]
        out = _aggregate_surfaced(hits, MAX_SURFACED_FILES, mode="many")
        assert [d["file_name"] for d in out] == ["strong.pdf"]

    def test_long_snippet_truncated(self):
        hits = [(_chunk("a.pdf", 0.8, "x" * 500), "projekt")]
        [doc] = _aggregate_surfaced(hits, MAX_SURFACED_FILES, mode="one")
        assert doc["snippet"].endswith("…")
        assert len(doc["snippet"]) <= 302

    def test_skips_chunks_without_file_name(self):
        hits = [(_chunk("", 0.8), "projekt"), (_chunk("a.pdf", 0.8), "projekt")]
        out = _aggregate_surfaced(hits, MAX_SURFACED_FILES, mode="one")
        assert [d["file_name"] for d in out] == ["a.pdf"]


class TestDocumentGridCardSchema:
    def test_validates_one_or_many_the_same_type(self):
        one = {
            "type": "document_grid",
            "title": "Brandschutz.pdf",
            "query": "Brandschutzplan",
            "documents": [
                {
                    "file_name": "Brandschutz.pdf",
                    "snippet": "Der zweite Fluchtweg…",
                    "page": 3,
                    "score": 0.82,
                    "source": "projekt",
                },
            ],
        }
        many = {
            "type": "document_grid",
            "title": "Relevante Dokumente – Fluchtwege",
            "query": "Fluchtwege",
            "documents": [
                {"file_name": "Brandschutz.pdf", "source": "projekt"},
                {"file_name": "Schnitt.pdf", "source": "projekt"},
            ],
        }
        one_out = grid_card_adapter.validate_python(one).model_dump(exclude_none=True)
        many_out = grid_card_adapter.validate_python(many).model_dump(exclude_none=True)
        assert one_out["type"] == many_out["type"] == "document_grid"
        assert len(one_out["documents"]) == 1
        assert len(many_out["documents"]) == 2

    def test_requires_at_least_one_document(self):
        import pytest

        card = {"type": "document_grid", "title": "Leer", "documents": []}
        with pytest.raises(Exception):
            grid_card_adapter.validate_python(card)

    def test_validate_cards_drops_model_fabricated_system_cards(self):
        from aiq_agent.cards.models import validate_cards

        raw = [
            {"type": "summary", "title": "ok"},
            {"type": "document_grid", "title": "fake", "documents": [{"file_name": "x.pdf"}]},
            {"type": "memory_proposal", "title": "fake", "content": "x", "kind": "decision"},
        ]
        out = validate_cards(raw)
        assert [c["type"] for c in out] == ["summary"]


class TestPlatformCounts:
    def _make_env(self, monkeypatch, names=("plan.pdf", "schnitt.pdf", "ansicht.pdf")):
        import aiq_agent.cards.surface_documents as surface_module

        chunks = [_chunk(name, 0.9 - i * 0.02, content=name) for i, name in enumerate(names)]
        retriever = SimpleNamespace(calls=[], chunks=chunks)

        async def retrieve(query, collection_name, top_k, filters):
            retriever.calls.append({"collection": collection_name, "top_k": top_k})
            return SimpleNamespace(chunks=retriever.chunks)

        retriever.retrieve = retrieve
        registry = SimpleNamespace(add=MagicMock())

        async def fake_meta(_collections):
            return {name: {"summary": name, "tags": []} for name in names}

        monkeypatch.setattr("aiq_agent.knowledge.scoping.get_collection_scope_from_context", lambda: ["proj_test"])
        monkeypatch.setattr("aiq_agent.knowledge.factory.get_active_retriever", lambda: retriever)
        monkeypatch.setattr("aiq_agent.cards.registry.get_card_registry", lambda: registry)
        monkeypatch.setattr(surface_module, "_fetch_document_metadata", fake_meta)
        return retriever, registry

    async def test_default_mode_opens_one_file(self, monkeypatch):
        retriever, registry = self._make_env(monkeypatch)

        async with surface_documents(SurfaceDocumentsConfig(), MagicMock()) as info:
            output = await info.single_fn(info.input_schema(query="Lageplan"))

        card = registry.add.call_args.args[0]
        assert card["type"] == "document_grid"
        assert [doc["file_name"] for doc in card["documents"]] == ["plan.pdf"]
        assert 'Opened "plan.pdf"' in output

    async def test_filename_skips_ambiguity(self, monkeypatch):
        _retriever, registry = self._make_env(monkeypatch)

        async with surface_documents(SurfaceDocumentsConfig(), MagicMock()) as info:
            await info.single_fn(info.input_schema(filename="schnitt.pdf"))

        card = registry.add.call_args.args[0]
        assert card["type"] == "document_grid"
        assert [doc["file_name"] for doc in card["documents"]] == ["schnitt.pdf"]

    async def test_mode_many_returns_close_set(self, monkeypatch):
        _retriever, registry = self._make_env(monkeypatch)

        async with surface_documents(SurfaceDocumentsConfig(), MagicMock()) as info:
            output = await info.single_fn(info.input_schema(query="Pläne", mode="many"))

        card = registry.add.call_args.args[0]
        assert card["type"] == "document_grid"
        names = [doc["file_name"] for doc in card["documents"]]
        assert names[0] == "plan.pdf"
        assert 1 <= len(names) <= MAX_SURFACED_FILES
        assert "close matches" in output or 'Opened "' in output

    async def test_platform_override_reaches_retriever(self, monkeypatch):
        def fake_get(key, fallback):
            return {"surface.chunk_top_k": 6, "surface.max_files": 1}[key]

        monkeypatch.setattr("aiq_agent.common.retrieval_settings.get_retrieval_setting", fake_get)
        retriever, registry = self._make_env(monkeypatch)

        async with surface_documents(SurfaceDocumentsConfig(), MagicMock()) as info:
            await info.single_fn(info.input_schema(query="Lageplan", mode="many"))

        assert retriever.calls == [{"collection": "proj_test", "top_k": 6}]
        card = registry.add.call_args.args[0]
        assert card["type"] == "document_grid"
        assert len(card["documents"]) == 1

    async def test_bff_outage_falls_back_to_constants(self, monkeypatch):
        from aiq_agent.common import retrieval_settings

        def boom():
            raise RuntimeError("BFF unreachable")

        monkeypatch.setattr(retrieval_settings, "_fetch_settings", boom)
        retrieval_settings.reset_retrieval_settings_cache()
        retriever, _registry = self._make_env(monkeypatch)

        async with surface_documents(SurfaceDocumentsConfig(), MagicMock()) as info:
            await info.single_fn(info.input_schema(query="Lageplan"))

        assert retriever.calls == [{"collection": "proj_test", "top_k": _CHUNK_TOP_K}]
        retrieval_settings.reset_retrieval_settings_cache()

    async def test_unknown_filename_steers_to_inventory(self, monkeypatch):
        _retriever, registry = self._make_env(monkeypatch)

        async with surface_documents(SurfaceDocumentsConfig(), MagicMock()) as info:
            output = await info.single_fn(info.input_schema(filename="nicht-da.pdf"))

        registry.add.assert_not_called()
        assert "inventory" in output.lower()
        assert "nicht-da.pdf" in output

    async def test_empty_search_steers_to_narrower_query(self, monkeypatch):
        retriever, registry = self._make_env(monkeypatch)

        async def retrieve(query, collection_name, top_k, filters):
            retriever.calls.append({"collection": collection_name, "top_k": top_k})
            return SimpleNamespace(chunks=[])

        retriever.retrieve = retrieve

        async with surface_documents(SurfaceDocumentsConfig(), MagicMock()) as info:
            output = await info.single_fn(info.input_schema(query="xyz-no-match"))

        registry.add.assert_not_called()
        assert "narrower" in output
        assert "inventory" in output.lower()


class TestBriefing:
    def test_one_file_is_four_to_six_lines_and_clips_snippet(self):
        text = _briefing_for_agent(
            "Fluchtwege",
            [
                {
                    "file_name": "Brandschutzplan_EG.pdf",
                    "source": "projekt",
                    "summary": "Brandschutzplan Erdgeschoss",
                    "snippet": "x" * 400,
                    "page": 3,
                    "_tags": ["brand", "flucht"],
                }
            ],
            "one",
        )
        lines = [ln for ln in text.splitlines() if ln.strip()]
        assert 4 <= len(lines) <= 6
        assert 'Opened "Brandschutzplan_EG.pdf" (Projekt)' in text
        assert "Brandschutzplan Erdgeschoss" in text
        assert "x" * 200 not in text
        assert len(next(ln for ln in lines if ln.startswith("S."))) <= _BRIEF_SNIPPET_MAX + 20

    def test_many_is_one_line_per_file_without_snippets(self):
        text = _briefing_for_agent(
            "Pläne",
            [
                {
                    "file_name": "a.pdf",
                    "source": "projekt",
                    "summary": "Lageplan EG",
                    "snippet": "long " * 80,
                },
                {
                    "file_name": "b.pdf",
                    "source": "buero",
                    "summary": "Schnitt AA",
                    "snippet": "long " * 80,
                },
            ],
            "many",
        )
        lines = [ln for ln in text.splitlines() if ln.strip()]
        assert lines[0].startswith("Offered 2 close matches")
        file_lines = [ln for ln in lines if ".pdf" in ln]
        assert len(file_lines) == 2
        assert all(ln.startswith("- ") for ln in file_lines)
        assert "long long" not in text


class TestToolContract:
    def test_description_splits_cite_from_show_and_blocks_double_call(self):
        desc = _TOOL_DESCRIPTION
        assert "knowledge_search" in desc
        assert "peeks the cited file" in desc
        assert "do not also call this tool after citing" in desc
        assert "filename=" in desc
        assert "mode=many" in desc
        assert "best matching file" in desc
