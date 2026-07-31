"""Tests for the ``surface_documents`` tool helpers and the ``document_grid`` card.

The tool runs a real vector search and emits a system card of REAL files; these
guard the pure logic — which collections it searches, how it labels their corpus,
and how it aggregates chunks to one best entry per file — plus the card schema.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock

from aiq_agent.cards.models import grid_card_adapter
from aiq_agent.cards.surface_documents import MAX_SURFACED_FILES
from aiq_agent.cards.surface_documents import SurfaceDocumentsConfig
from aiq_agent.cards.surface_documents import _aggregate_surfaced
from aiq_agent.cards.surface_documents import _source_for_collection
from aiq_agent.cards.surface_documents import _target_collections
from aiq_agent.cards.surface_documents import surface_documents


def _chunk(file_name, score, content="passage", page=1):
    return SimpleNamespace(file_name=file_name, score=score, content=content, page_number=page)


class TestSourceForCollection:
    def test_project_and_archiv_and_base(self):
        assert _source_for_collection("proj_abc") == "projekt"
        assert _source_for_collection("archiv_org1") == "buero"
        # The base OIB corpus is law, not a user document store — not surfaced.
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


class TestAggregateSurfaced:
    def test_one_best_entry_per_file_sorted_by_score(self):
        hits = [
            (_chunk("a.pdf", 0.4, "low a"), "projekt"),
            (_chunk("a.pdf", 0.9, "best a", page=3), "projekt"),
            (_chunk("b.pdf", 0.7, "b only"), "buero"),
        ]
        out = _aggregate_surfaced(hits, MAX_SURFACED_FILES)
        assert [d["file_name"] for d in out] == ["a.pdf", "b.pdf"]
        assert out[0]["snippet"] == "best a"
        assert out[0]["page"] == 3
        assert out[0]["score"] == 0.9
        assert out[0]["source"] == "projekt"
        assert out[1]["source"] == "buero"

    def test_caps_to_max_files(self):
        # All comfortably above the quality floor so the cap (not the floor) applies.
        hits = [(_chunk(f"f{i}.pdf", 0.5 + i / 100), "projekt") for i in range(30)]
        out = _aggregate_surfaced(hits, MAX_SURFACED_FILES)
        assert len(out) == MAX_SURFACED_FILES
        # Highest scores survive the cap.
        assert out[0]["file_name"] == "f29.pdf"

    def test_drops_weak_matches_below_quality_floor(self):
        from aiq_agent.cards.surface_documents import MIN_SURFACE_SCORE

        hits = [
            (_chunk("strong.pdf", MIN_SURFACE_SCORE + 0.1), "projekt"),
            (_chunk("weak.pdf", MIN_SURFACE_SCORE - 0.1), "projekt"),
        ]
        out = _aggregate_surfaced(hits, MAX_SURFACED_FILES)
        assert [d["file_name"] for d in out] == ["strong.pdf"]

    def test_long_snippet_truncated(self):
        hits = [(_chunk("a.pdf", 0.5, "x" * 500), "projekt")]
        [doc] = _aggregate_surfaced(hits, MAX_SURFACED_FILES)
        assert doc["snippet"].endswith("…")
        assert len(doc["snippet"]) <= 302

    def test_skips_chunks_without_file_name(self):
        hits = [(_chunk("", 0.5), "projekt"), (_chunk("a.pdf", 0.6), "projekt")]
        out = _aggregate_surfaced(hits, MAX_SURFACED_FILES)
        assert [d["file_name"] for d in out] == ["a.pdf"]


class TestDocumentGridCardSchema:
    def test_validates_full_card(self):
        card = {
            "type": "document_grid",
            "title": "Relevante Dokumente – Fluchtwege",
            "query": "Fluchtwege",
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
        validated = grid_card_adapter.validate_python(card).model_dump(exclude_none=True)
        assert validated["type"] == "document_grid"
        assert validated["documents"][0]["file_name"] == "Brandschutz.pdf"

    def test_requires_at_least_one_document(self):
        import pytest

        card = {"type": "document_grid", "title": "Leer", "documents": []}
        with pytest.raises(Exception):
            grid_card_adapter.validate_python(card)

    def test_validate_cards_drops_model_fabricated_system_cards(self):
        # The batch/post-hoc path is fed by MODEL output; a system card there is a
        # fabrication and must be dropped (only its owning tool may emit it).
        from aiq_agent.cards.models import validate_cards

        raw = [
            {"type": "summary", "title": "ok"},
            {"type": "document_grid", "title": "fake", "documents": [{"file_name": "x.pdf"}]},
            {"type": "memory_proposal", "title": "fake", "content": "x", "kind": "decision"},
        ]
        out = validate_cards(raw)
        assert [c["type"] for c in out] == ["summary"]


class TestPlatformCounts:
    """The surfaced chunk/file counts come from Platform → Retrieval when pinned
    there, and fall back to the module constants otherwise."""

    def _make_env(self, monkeypatch):
        import aiq_agent.cards.surface_documents as surface_module

        chunks = [
            _chunk("plan.pdf", 0.9, content="Lageplan"),
            _chunk("schnitt.pdf", 0.85, content="Schnitt A-A"),
            _chunk("ansicht.pdf", 0.8, content="Ansicht Süd"),
        ]
        retriever = SimpleNamespace(calls=[], chunks=chunks)

        async def retrieve(query, collection_name, top_k, filters):
            retriever.calls.append({"collection": collection_name, "top_k": top_k})
            return SimpleNamespace(chunks=retriever.chunks)

        retriever.retrieve = retrieve
        registry = SimpleNamespace(add=MagicMock())

        monkeypatch.setattr("aiq_agent.knowledge.scoping.get_collection_scope_from_context", lambda: ["proj_test"])
        monkeypatch.setattr("aiq_agent.knowledge.factory.get_active_retriever", lambda: retriever)
        monkeypatch.setattr("aiq_agent.cards.registry.get_card_registry", lambda: registry)
        monkeypatch.setattr(surface_module, "_fetch_document_metadata", _async_noop_metadata)
        return retriever, registry

    async def test_platform_override_reaches_retriever_and_caps_grid(self, monkeypatch):
        def fake_get(key, fallback):
            return {"surface.chunk_top_k": 6, "surface.max_files": 1}[key]

        monkeypatch.setattr("aiq_agent.common.retrieval_settings.get_retrieval_setting", fake_get)

        retriever, registry = self._make_env(monkeypatch)

        async with surface_documents(SurfaceDocumentsConfig(), MagicMock()) as info:
            output = await info.single_fn(info.input_schema(query="Lageplan"))

        assert retriever.calls == [{"collection": "proj_test", "top_k": 6}]
        card = registry.add.call_args.args[0]
        assert [doc["file_name"] for doc in card["documents"]] == ["plan.pdf"]
        assert "plan.pdf" in output

    async def test_resolver_failure_falls_back_to_constants(self, monkeypatch):
        def boom(key, fallback):
            raise RuntimeError("BFF unreachable")

        monkeypatch.setattr("aiq_agent.common.retrieval_settings.get_retrieval_setting", boom)

        retriever, registry = self._make_env(monkeypatch)

        async with surface_documents(SurfaceDocumentsConfig(), MagicMock()) as info:
            await info.single_fn(info.input_schema(query="Lageplan"))

        assert retriever.calls == [{"collection": "proj_test", "top_k": 24}]
        card = registry.add.call_args.args[0]
        assert len(card["documents"]) == 3


async def _async_noop_metadata(collections):
    return {}
