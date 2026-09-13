"""Short-overview card suppression: vetoes, callout survival, takeaway window.

Covers ``answer_pipeline._suppress_cards`` — the mechanical floor that drops
unearned ``emit_card`` cards on a short, non-ruling answer without a verdict:

1. **legal_basis veto** — the card is the answer's proof, not its trailer, so
   any ``legal_basis`` card in the registry snapshot vetoes the suppression.
2. **Callout survival** — below the takeaway floor the trailer shrinks to the
   callout alone; the ``[[callout]]`` marker resolves against exactly that
   field, so dropping it would silence a warning the gates deliberately kept.
3. **Takeaway window** — at or above the takeaway floor (600) but below the
   card floor (800) the cards go while the gated takeaways stay (650-char
   case).
4. **Sibling probes** — every other system emitter's card type is a catalog
   member and vetoes the suppression: ``memory_proposal``, ``task_created``,
   ``document_draft`` via write/edit and via the ``file_draft`` re-push (plus
   ``document_grid`` and ``file_operation_proposal`` for the full set).
"""

import json

import pytest
from langchain_core.messages import AIMessage

from aiq_agent.agents.piloti.answer_pipeline import _Extracted
from aiq_agent.agents.piloti.answer_pipeline import _gated_meta
from aiq_agent.agents.piloti.answer_pipeline import _should_suppress_meta_cards
from aiq_agent.agents.piloti.answer_pipeline import _suppress_cards
from aiq_agent.agents.piloti.answer_pipeline import finalize_answer
from aiq_agent.cards.registry import CardRegistry
from aiq_agent.cards.registry import reset_card_registry
from aiq_agent.cards.registry import set_card_registry
from aiq_agent.common.answer_envelope import AnswerMeta
from aiq_agent.common.answer_envelope import gate_answer_meta
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry

#: Below the card floor (800) but above the takeaway floor (600): cards go,
#: takeaways stay.
WINDOW_PROSE = "x" * 650
#: Below both floors: the trailer shrinks to the callout alone.
SHORT_PROSE = "x" * 300

_CALLOUT = {"kind": "frist", "text": "Die Bauverhandlung ist binnen sechs Wochen anzuberaumen."}
_TAKEAWAYS = [
    {"text": "Massgeblich ist das Fluchtniveau, nicht die Geschosszahl"},
    {"text": "Tragende Bauteile mindestens REI 60", "detail": "Nach OIB-Richtlinie 2, Tabelle 1b."},
]


@pytest.fixture
def card_registry():
    """A bound turn card registry, reset afterwards like the chat entrypoint."""
    registry = CardRegistry()
    token = set_card_registry(registry)
    yield registry
    reset_card_registry(token)


def _gated(payload: dict, prose_chars: int) -> dict | None:
    return gate_answer_meta(AnswerMeta.model_validate(payload), prose_chars=prose_chars)


def _oib_source():
    return SourceEntry(
        citation_key="oib-rl_2_ausgabe_mai_2023.pdf, p.12",
        title="OIB-Richtlinie 2",
        source_type="knowledge_layer",
        tool_name="knowledge_search",
        collection="oib_knowledge",
    )


class TestShouldSuppressMetaCards:
    def test_no_meta_is_nothing_to_drop(self):
        assert _should_suppress_meta_cards(WINDOW_PROSE, None) is False

    def test_prose_at_the_floor_earns_its_cards(self):
        meta = _gated({"takeaways": _TAKEAWAYS}, prose_chars=1_000)
        assert _should_suppress_meta_cards("x" * 800, meta) is False

    def test_prose_one_char_under_the_floor_drops(self):
        meta = _gated({"takeaways": _TAKEAWAYS}, prose_chars=799)
        assert _should_suppress_meta_cards("x" * 799, meta) is True

    def test_a_verdict_vetoes(self):
        meta = _gated(
            {"verdict": {"value": "REI 60", "subject": "Feuerwiderstand"}},
            prose_chars=300,
        )
        assert _should_suppress_meta_cards(SHORT_PROSE, meta) is False

    def test_a_ruling_vetoes(self):
        meta = _gated({"kind": "ruling", "callout": _CALLOUT}, prose_chars=300)
        assert _should_suppress_meta_cards(SHORT_PROSE, meta) is False

    def test_short_direct_answer_without_verdict_drops(self):
        meta = _gated({"kind": "direct", "callout": _CALLOUT}, prose_chars=300)
        assert _should_suppress_meta_cards(SHORT_PROSE, meta) is True


class TestLegalBasisVeto:
    """The proof survives: a ``legal_basis`` card vetoes the suppression."""

    def test_a_legal_basis_card_keeps_cards_markers_and_meta(self, card_registry):
        from aiq_agent.cards.catalog import SYSTEM_CARD_TYPES

        assert "legal_basis" not in SYSTEM_CARD_TYPES
        meta = _gated({"kind": "direct", "callout": _CALLOUT}, prose_chars=300)
        assert _should_suppress_meta_cards(SHORT_PROSE, meta) is True
        card_registry.add({"type": "legal_basis", "law": "OIB-Richtlinie 2"})
        content = SHORT_PROSE + "\n\n[[card:1]]\n"

        kept_content, kept_meta, suppressed = _suppress_cards(content, meta)

        assert suppressed is False
        assert kept_meta == meta
        assert "[[card:1]]" in kept_content
        assert len(card_registry) == 1

    def test_the_veto_holds_among_other_cards(self, card_registry):
        meta = _gated({"kind": "direct", "callout": _CALLOUT}, prose_chars=300)
        card_registry.add({"type": "typed_table", "title": "Tabelle"})
        card_registry.add({"type": "legal_basis", "law": "OIB-Richtlinie 2"})

        _, kept_meta, suppressed = _suppress_cards(SHORT_PROSE, meta)

        assert suppressed is False
        assert kept_meta == meta
        assert len(card_registry) == 2


class TestCalloutSurvival:
    """Below the takeaway floor the trailer shrinks to the callout alone."""

    def test_suppression_preserves_the_callout_field(self, card_registry):
        meta = _gated({"kind": "direct", "callout": _CALLOUT}, prose_chars=300)
        card_registry.add({"type": "typed_table", "title": "Tabelle"})
        content = SHORT_PROSE + "\n\n[[card:1]]\n"

        kept_content, kept_meta, suppressed = _suppress_cards(content, meta)

        assert suppressed is True
        assert kept_meta is not None
        assert set(kept_meta) == {"v", "callout"}
        assert kept_meta["callout"] == _CALLOUT
        assert len(card_registry) == 0
        assert "[[card:1]]" not in kept_content

    def test_no_callout_is_meta_none_not_an_empty_object(self, card_registry):
        meta = _gated({"kind": "direct", "summary": "REI 60 in GK 4."}, prose_chars=300)
        assert meta is not None

        _, kept_meta, suppressed = _suppress_cards(SHORT_PROSE, meta)

        assert suppressed is True
        assert kept_meta is None

    async def test_the_callout_marker_survives_suppression_end_to_end(self):
        """The full path: suppression keeps the field, the marker resolves."""
        prose = "Die Antwort ist kurz [1].\n\n[[callout]]\n\nMehr Text.\n\n## References\n- [1] https://example.com"
        envelope = {"answer": prose, "kind": "direct", "callout": _CALLOUT}
        messages = [AIMessage(content="```answer_json\n" + json.dumps(envelope) + "\n```")]
        registry = SourceRegistry()
        registry.add(SourceEntry(url="https://example.com", tool_name="web"))

        final = await finalize_answer(messages, registry=registry, tools=[], repair=None)

        assert final.answer_meta is not None
        assert final.answer_meta["callout"]["kind"] == "frist"
        assert final.content is not None and final.content.count("[[callout]]") == 1


class TestTakeawayWindow:
    """At 650 chars the cards go while the gated takeaways stay."""

    def test_cards_cleared_takeaways_kept_at_650_chars(self, card_registry):
        meta = _gated({"takeaways": _TAKEAWAYS, "callout": _CALLOUT}, prose_chars=650)
        assert meta is not None and "takeaways" in meta
        card_registry.add({"type": "typed_table", "title": "Tabelle"})
        content = WINDOW_PROSE + "\n\n[[card:1]]\n"

        kept_content, kept_meta, suppressed = _suppress_cards(content, meta)

        assert suppressed is True
        assert kept_meta == meta
        assert [item["text"] for item in kept_meta["takeaways"]] == [t["text"] for t in _TAKEAWAYS]
        assert len(card_registry) == 0
        assert "[[card:1]]" not in kept_content

    def test_one_char_under_the_takeaway_floor_shrinks_to_the_callout(self, card_registry):
        meta = _gated({"takeaways": _TAKEAWAYS, "callout": _CALLOUT}, prose_chars=599)
        assert meta is not None and "takeaways" not in meta

        _, kept_meta, suppressed = _suppress_cards("x" * 599, meta)

        assert suppressed is True
        assert kept_meta is not None and set(kept_meta) == {"v", "callout"}


class TestSiblingProbes:
    """Every system emitter's card vetoes the suppression — by catalog, by path."""

    def test_memory_proposal_is_a_catalog_member_and_vetoes(self, card_registry):
        from aiq_agent.cards.catalog import SYSTEM_CARD_TYPES

        assert "memory_proposal" in SYSTEM_CARD_TYPES
        card_registry.add(
            {"type": "memory_proposal", "title": "T", "content": "C", "kind": "decision", "confidence": "high"}
        )
        meta = _gated({"kind": "direct", "callout": _CALLOUT}, prose_chars=300)

        _, kept_meta, suppressed = _suppress_cards(SHORT_PROSE, meta)

        assert suppressed is False
        assert kept_meta == meta
        assert len(card_registry) == 1

    def test_task_created_is_a_catalog_member_and_vetoes(self, card_registry):
        from aiq_agent.cards.catalog import SYSTEM_CARD_TYPES
        from aiq_agent.tools.tasks.cards import emit_task_card

        assert "task_created" in SYSTEM_CARD_TYPES
        assert (
            emit_task_card(
                {"taskId": "t-1", "kind": "document", "title": "Ziel", "conversationId": "c"},
                goal="Ziel",
                kind="document",
            )
            is True
        )
        meta = _gated({"kind": "direct", "callout": _CALLOUT}, prose_chars=300)

        _, kept_meta, suppressed = _suppress_cards(SHORT_PROSE, meta)

        assert suppressed is False
        assert kept_meta == meta
        assert len(card_registry) == 1

    def test_document_draft_from_a_write_vetoes(self, card_registry):
        from aiq_agent.cards.catalog import SYSTEM_CARD_TYPES
        from aiq_agent.tools.documents.cards import emit_draft_card

        assert "document_draft" in SYSTEM_CARD_TYPES
        assert emit_draft_card(path="vermerk.md", content="# Titel\n\nText", version=1) is True
        meta = _gated({"kind": "direct", "callout": _CALLOUT}, prose_chars=300)

        _, kept_meta, suppressed = _suppress_cards(SHORT_PROSE, meta)

        assert suppressed is False
        assert kept_meta == meta
        assert len(card_registry) == 1

    def test_document_draft_from_the_file_draft_repush_vetoes(self, card_registry):
        """The re-push carries the filing — same type, the filed shape."""
        from aiq_agent.cards.catalog import SYSTEM_CARD_TYPES
        from aiq_agent.tools.documents.cards import emit_draft_card

        assert "document_draft" in SYSTEM_CARD_TYPES
        assert (
            emit_draft_card(
                path="vermerk.md",
                content="# Titel\n\nText",
                version=2,
                filing={
                    "grid_filed_document_id": "doc-1",
                    "grid_filed_version_id": "ver-2",
                    "grid_filed_state": "in_review",
                },
            )
            is True
        )
        assert card_registry.snapshot()[0].get("document_id") == "doc-1"
        meta = _gated({"kind": "direct", "callout": _CALLOUT}, prose_chars=300)

        _, kept_meta, suppressed = _suppress_cards(SHORT_PROSE, meta)

        assert suppressed is False
        assert kept_meta == meta
        assert len(card_registry) == 1

    def test_the_rest_of_the_system_set_vetoes_too(self, card_registry):
        """``document_grid`` and ``file_operation_proposal`` complete the set."""
        from aiq_agent.cards.catalog import SYSTEM_CARD_TYPES

        for card_type in ("document_grid", "file_operation_proposal"):
            assert card_type in SYSTEM_CARD_TYPES
        card_registry.add({"type": "document_grid", "title": "Dateien"})
        card_registry.add(
            {
                "type": "file_operation_proposal",
                "title": "Verschieben",
                "operation": "move",
                "operations": [],
            }
        )
        meta = _gated({"kind": "direct", "callout": _CALLOUT}, prose_chars=300)

        _, kept_meta, suppressed = _suppress_cards(SHORT_PROSE, meta)

        assert suppressed is False
        assert kept_meta == meta
        assert len(card_registry) == 2


class TestTrailerValueWiring:
    """``_gated_meta`` threads this turn's captures into the trailer-value gate."""

    def _extracted(self, payload: dict) -> _Extracted:
        return _Extracted(
            content="x" * 700,
            meta=AnswerMeta.model_validate(payload),
            escalation_requested=False,
            confidence=None,
            confidence_reason=None,
        )

    def test_a_verdict_with_a_resolving_fundstelle_survives(self):
        extracted = self._extracted(
            {
                "verdict": {
                    "value": "100 cm",
                    "subject": "Erforderliche Gelanderhohe",
                    "reference": {"document": "OIB-Richtlinie 2"},
                }
            }
        )
        meta = _gated_meta(extracted, "x" * 700, SourceRegistry(), turn_sources=[_oib_source()])

        assert meta is not None and meta["verdict"]["value"] == "100 cm"

    def test_a_verdict_with_no_fundstelle_in_the_captures_drops(self):
        extracted = self._extracted({"verdict": {"value": "100 cm", "subject": "Erforderliche Gelanderhohe"}})
        stranger = SourceEntry(citation_key="plan.pdf, p.1", title="Plan", source_type="knowledge_layer")
        assert _gated_meta(extracted, "x" * 700, SourceRegistry(), turn_sources=[stranger]) is None

    def test_a_takeaway_with_a_fundstelle_in_its_detail_survives(self):
        extracted = self._extracted({"takeaways": _TAKEAWAYS})
        meta = _gated_meta(extracted, "x" * 700, SourceRegistry(), turn_sources=[_oib_source()])

        assert meta is not None
        assert [item["text"] for item in meta["takeaways"]] == [t["text"] for t in _TAKEAWAYS]
