"""Phase-2 norm-registry retrieval behavior: default filters, parent expansion, stratum labels."""

import pytest
from knowledge_layer import register as reg
from knowledge_layer.register import KnowledgeRetrievalConfig

from aiq_agent.knowledge.schema import Chunk
from aiq_agent.knowledge.schema import ContentType
from aiq_agent.knowledge.schema import RetrievalResult

RL2_META = {
    "doc_id": "oib-rl-2",
    "doc_short": "OIB-RL 2",
    "doc_title": "Brandschutz",
    "edition": "2023-05",
    "edition_label": "Ausgabe Mai 2023",
    "edition_status": "current",
    "rank": "oib_richtlinie",
    "role": "normativ",
    "country": "at",
    "punkt": "3.1.2",
    "punkt_title": "Brandabschnitte",
}

PREFIX = "OIB-RL 2 - Brandschutz (Ausgabe Mai 2023), Pkt 3.1.2, normativ\n"


def _chunk(content: str, score: float = 0.5, metadata: dict | None = None, chunk_id: str = "c") -> Chunk:
    return Chunk(
        chunk_id=chunk_id,
        content=content,
        score=score,
        file_name="oib-rl_2_ausgabe_mai_2023.pdf",
        display_citation="oib-rl_2_ausgabe_mai_2023.pdf",
        content_type=ContentType.TEXT,
        metadata=metadata or {},
    )


def _sibling(body: str, chunk_index: int) -> Chunk:
    meta = {**RL2_META, "chunk_index": chunk_index}
    return _chunk(PREFIX + body, metadata=meta, chunk_id=f"s{chunk_index}")


class TestConfigFields:
    def test_parent_expansion_defaults_true(self):
        config = KnowledgeRetrievalConfig(collection_name="oib_knowledge")
        assert config.parent_expansion is True


class TestBaseCollectionFilters:
    def test_exclusions_only_when_registry_unavailable(self, monkeypatch):
        monkeypatch.setattr(reg, "_default_norm_filters", None)
        config = KnowledgeRetrievalConfig(collection_name="oib_knowledge", exclude_file_names=["b.pdf", "a.pdf"])
        assert reg._base_collection_filters(config, None) == {"file_name": {"$nin": ["a.pdf", "b.pdf"]}}

    def test_registry_default_merged_with_exclusions(self, monkeypatch):
        default = {"$and": [{"role": {"$nin": ["diff"]}}]}
        monkeypatch.setattr(reg, "_load_norm_registry", lambda: object())
        monkeypatch.setattr(reg, "_resolve_norm_bundesland", lambda text: None)
        monkeypatch.setattr(reg, "_default_norm_filters", lambda registry, bundesland: default)
        config = KnowledgeRetrievalConfig(collection_name="oib_knowledge", exclude_file_names=["x.pdf"])
        assert reg._base_collection_filters(config, None) == {"$and": [{"file_name": {"$nin": ["x.pdf"]}}, default]}

    def test_caller_filters_override_registry_default_but_keep_exclusions(self, monkeypatch):
        monkeypatch.setattr(reg, "_load_norm_registry", lambda: object())
        monkeypatch.setattr(reg, "_resolve_norm_bundesland", lambda text: None)
        monkeypatch.setattr(reg, "_default_norm_filters", lambda registry, bundesland: {"role": "normativ"})
        config = KnowledgeRetrievalConfig(collection_name="oib_knowledge", exclude_file_names=["x.pdf"])
        caller = {"role": "diff"}
        assert reg._base_collection_filters(config, caller) == {"$and": [{"file_name": {"$nin": ["x.pdf"]}}, caller]}

    def test_caller_filters_pass_through_when_no_exclusions(self, monkeypatch):
        monkeypatch.setattr(reg, "_default_norm_filters", None)
        config = KnowledgeRetrievalConfig(collection_name="oib_knowledge")
        caller = {"punkt": "3.1.2"}
        assert reg._base_collection_filters(config, caller) == caller

    def test_none_when_nothing_configured(self, monkeypatch):
        monkeypatch.setattr(reg, "_default_norm_filters", None)
        config = KnowledgeRetrievalConfig(collection_name="oib_knowledge")
        assert reg._base_collection_filters(config, None) is None

    def test_registry_load_failure_is_fail_open(self, monkeypatch):
        def _boom():
            raise RuntimeError("registry broken")

        monkeypatch.setattr(reg, "_load_norm_registry", _boom)
        monkeypatch.setattr(reg, "_resolve_norm_bundesland", lambda text: None)
        monkeypatch.setattr(reg, "_default_norm_filters", lambda registry, bundesland: {"role": "normativ"})
        config = KnowledgeRetrievalConfig(collection_name="oib_knowledge", exclude_file_names=["x.pdf"])
        assert reg._base_collection_filters(config, None) == {"file_name": {"$nin": ["x.pdf"]}}


class TestNormParentKey:
    def test_complete_metadata(self):
        assert reg._norm_parent_key(RL2_META) == ("oib-rl-2", "2023-05", "3.1.2")

    @pytest.mark.parametrize("missing", ["doc_id", "edition", "punkt"])
    def test_missing_field_returns_none(self, missing):
        meta = {k: v for k, v in RL2_META.items() if k != missing}
        assert reg._norm_parent_key(meta) is None

    def test_none_metadata(self):
        assert reg._norm_parent_key(None) is None


class TestBuildParentContent:
    def test_joins_in_chunk_index_order_with_single_prefix(self):
        siblings = [_sibling("zweiter Absatz", 1), _sibling("erster Absatz", 0)]
        content = reg._build_parent_content(siblings)
        assert content.startswith(PREFIX)
        assert content.count("Pkt 3.1.2, normativ") == 1
        assert content.index("erster Absatz") < content.index("zweiter Absatz")

    def test_truncates_at_cap(self):
        siblings = [_sibling("x" * 5000, 0), _sibling("y" * 5000, 1)]
        content = reg._build_parent_content(siblings, max_chars=2000)
        assert len(content) <= 2000 + len("… [truncated]")
        assert content.endswith("… [truncated]")

    def test_chunk_without_known_prefix_kept_whole(self):
        weird = _chunk("kein Präfix hier", metadata={**RL2_META, "chunk_index": 0})
        content = reg._build_parent_content([weird])
        assert "kein Präfix hier" in content


class TestExpandNormParents:
    def test_group_collapses_to_highest_score_member(self):
        plain = _chunk("unstrukturiert", score=0.6, metadata={"file_name": "user.pdf"}, chunk_id="plain")
        hit_a = _chunk(PREFIX + "a", score=0.7, metadata={**RL2_META, "chunk_index": 0}, chunk_id="a")
        hit_b = _chunk(PREFIX + "b", score=0.9, metadata={**RL2_META, "chunk_index": 1}, chunk_id="b")
        siblings = [_sibling("a", 0), _sibling("b", 1), _sibling("c", 2)]
        key = ("oib-rl-2", "2023-05", "3.1.2")
        out = reg._expand_norm_parents([hit_a, plain, hit_b], {key: siblings})
        assert len(out) == 2
        rep = next(c for c in out if c.metadata.get("_expanded"))
        assert rep.chunk_id == "b"
        assert rep.score == 0.9
        assert "c" in rep.content
        assert plain in out

    def test_group_without_siblings_left_untouched(self):
        hit = _chunk(PREFIX + "a", metadata={**RL2_META, "chunk_index": 0})
        out = reg._expand_norm_parents([hit], {})
        assert out == [hit]

    def test_no_norm_metadata_noop(self):
        plain = _chunk("x", metadata={"file_name": "user.pdf"})
        assert reg._expand_norm_parents([plain], {("d", "e", "p"): []}) == [plain]


class TestFormatStratumLabels:
    def _result(self, chunks):
        return RetrievalResult(chunks=chunks, query="q", backend="llamaindex")

    def test_norm_chunk_gets_stratum_and_registry_citation(self):
        chunk = _chunk("body", metadata={**RL2_META, "chunk_index": 0})
        out = reg._format_results(self._result([chunk]), "q")
        assert "Stratum: oib_richtlinie · normativ · Ausgabe Mai 2023" in out
        assert "Citation: OIB-RL 2, Pkt 3.1.2, Ausgabe Mai 2023" in out

    def test_plain_chunk_unchanged(self):
        chunk = _chunk("body", metadata={})
        chunk.page_number = 3
        out = reg._format_results(self._result([chunk]), "q")
        assert "Stratum:" not in out
        assert "Citation: oib-rl_2_ausgabe_mai_2023.pdf, p.3" in out

    def test_expanded_chunk_uses_higher_truncation_cap(self):
        meta = {**RL2_META, "chunk_index": 0, "_expanded": True}
        chunk = _chunk("y" * 3000, metadata=meta)
        out = reg._format_results(self._result([chunk]), "q")
        assert "y" * 3000 in out
        assert "[truncated]" not in out

    def test_regular_chunk_still_truncated_at_1500(self):
        chunk = _chunk("z" * 2000, metadata={})
        out = reg._format_results(self._result([chunk]), "q")
        assert "z" * 2000 not in out
        assert "[truncated]" in out

RIS_META = {
    "doc_id": "bo-wien",
    "doc_short": "BauO Wien",
    "doc_title": "Bauordnung für Wien",
    "edition": "konsolidiert",
    "edition_label": "Konsolidierte Fassung (laufend)",
    "edition_status": "current",
    "rank": "landesgesetz",
    "role": "normativ",
    "country": "at",
    "document_number": "LWI40000225",
    "paragraph": "5",
}

RIS_PREFIX = "BauO Wien - Bauordnung für Wien (Konsolidierte Fassung (laufend)), § 5, normativ\n"


class TestRisKnowledgeFanOut:
    def test_header_scope_appended(self, monkeypatch):
        monkeypatch.setattr(
            "aiq_agent.knowledge.scoping.get_collection_scope_from_context",
            lambda: ["oib_knowledge", "s_conv"],
        )
        config = KnowledgeRetrievalConfig(collection_name="oib_knowledge")
        assert reg._resolve_target_collections(config, None) == ["oib_knowledge", "s_conv", "ris_knowledge"]

    def test_header_scope_deduped_when_present(self, monkeypatch):
        monkeypatch.setattr(
            "aiq_agent.knowledge.scoping.get_collection_scope_from_context",
            lambda: ["oib_knowledge", "ris_knowledge"],
        )
        config = KnowledgeRetrievalConfig(collection_name="oib_knowledge")
        assert reg._resolve_target_collections(config, None) == ["oib_knowledge", "ris_knowledge"]

    def test_legacy_path_appended(self, monkeypatch):
        monkeypatch.setattr("aiq_agent.knowledge.scoping.get_collection_scope_from_context", lambda: None)
        config = KnowledgeRetrievalConfig(collection_name="oib_knowledge", include_base_collection=True)
        assert reg._resolve_target_collections(config, None) == ["oib_knowledge", "ris_knowledge"]

    def test_fixed_collection_stays_pinned(self, monkeypatch):
        monkeypatch.setattr("aiq_agent.knowledge.scoping.get_collection_scope_from_context", lambda: None)
        config = KnowledgeRetrievalConfig(collection_name="oib_knowledge", use_fixed_collection=True)
        assert reg._resolve_target_collections(config, None) == ["oib_knowledge"]


class TestNormCollectionGate:
    def test_base_and_ris_knowledge_are_norm_collections(self):
        config = KnowledgeRetrievalConfig(collection_name="oib_knowledge")
        assert reg._is_norm_collection(config, "oib_knowledge")
        assert reg._is_norm_collection(config, "ris_knowledge")
        assert not reg._is_norm_collection(config, "proj_123")
        assert not reg._is_norm_collection(config, "s_conv")


class TestParagraphAnchors:
    def test_parent_key_falls_back_to_paragraph(self):
        assert reg._norm_parent_key(RIS_META) == ("bo-wien", "konsolidiert", "5")

    def test_anchor_field_prefers_punkt(self):
        assert reg._norm_anchor_field({**RIS_META, "punkt": "3.1"}) == "punkt"
        assert reg._norm_anchor_field(RIS_META) == "paragraph"
        assert reg._norm_anchor_field({"doc_id": "x"}) is None

    def test_strip_paragraph_prefix_with_role(self):
        prefix, body = reg._strip_known_prefix(RIS_PREFIX + "Paragraph body.", RIS_META)
        assert prefix == RIS_PREFIX
        assert body == "Paragraph body."

    def test_strip_paragraph_prefix_without_role(self):
        meta = {k: v for k, v in RIS_META.items() if k != "role"}
        text = "BauO Wien - Bauordnung für Wien (Konsolidierte Fassung (laufend)), § 5\nbody"
        prefix, body = reg._strip_known_prefix(text, meta)
        assert body == "body"

    def test_ris_chunk_gets_paragraph_citation(self):
        chunk = _chunk("body", metadata={**RIS_META, "chunk_index": 0})
        out = reg._format_results(RetrievalResult(chunks=[chunk], query="q", backend="llamaindex"), "q")
        assert "Citation: BauO Wien, § 5, Konsolidierte Fassung (laufend)" in out
        assert "Stratum: landesgesetz" in out
