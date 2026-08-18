"""Tests for Grid card models."""

import typing

from aiq_agent.cards.models import MemoryProposalCard
from aiq_agent.cards.models import grid_card_adapter
from aiq_agent.cards.models import validate_cards


class TestMemoryProposalCard:
    """The system-emitted memory_proposal card validates and routes correctly."""

    def test_validates_with_defaults(self):
        card = MemoryProposalCard(
            type="memory_proposal",
            title="Save this finding?",
            content="The client requires all facades to be non-combustible.",
            kind="constraint",
        )
        assert card.confidence == "medium"

    def test_adapter_routes_type(self):
        raw = {
            "type": "memory_proposal",
            "title": "Save this finding?",
            "content": "The firm always uses REI 90 for GK4.",
            "kind": "preference",
            "confidence": "high",
        }
        validated = grid_card_adapter.validate_python(raw)
        assert isinstance(validated, MemoryProposalCard)
        assert validated.kind == "preference"
        assert validated.confidence == "high"

    def test_validate_cards_drops_it_as_a_model_fabrication(self):
        # `validate_cards` is the post-hoc/batch path fed by MODEL output. A
        # system card there is a fabrication (the model is never told the type
        # exists), so it is dropped — only the `remember` tool may emit a real
        # memory_proposal, straight into the registry via the adapter.
        raw = [
            {
                "type": "memory_proposal",
                "title": "Save this finding?",
                "content": "The site is in a Schutzzone.",
                "kind": "derived_fact",
            }
        ]
        assert validate_cards(raw) == []
        # The adapter itself (the sanctioned tool path) still accepts it.
        assert grid_card_adapter.validate_python(raw[0]).confidence == "medium"


class TestValidateCards:
    """Tests for validate_cards.

    Contract: validation is per-item and tolerant — invalid cards are dropped
    (and logged), never raised, so one bad card can't discard a whole batch or
    fail the answer. Cards are a progressive enhancement.
    """

    def test_accepts_valid_summary_dict(self):
        raw = [{"type": "summary", "title": "Summary title", "content": "Summary content"}]
        result = validate_cards(raw)
        assert result == raw

    def test_accepts_valid_legal_basis_dict(self):
        raw = [{"type": "legal_basis", "law": "OIB Richtlinie 1"}]
        result = validate_cards(raw)
        assert result == raw

    def test_drops_unknown_card_type(self):
        raw = [{"type": "unknown_type", "title": "Unknown"}]
        assert validate_cards(raw) == []

    def test_drops_card_missing_required_field(self):
        raw = [{"type": "summary"}]
        assert validate_cards(raw) == []

    def test_keeps_valid_cards_and_drops_invalid_in_same_batch(self):
        raw = [
            {"type": "summary", "title": "Good"},
            {"type": "summary"},  # missing required title -> dropped
            {"type": "legal_basis", "law": "OIB Richtlinie 3"},
        ]
        result = validate_cards(raw)
        assert result == [
            {"type": "summary", "title": "Good"},
            {"type": "legal_basis", "law": "OIB Richtlinie 3"},
        ]

    def test_accepts_requirement_checklist(self):
        raw = [
            {
                "type": "requirement_checklist",
                "title": "Anforderungen GK 4",
                "items": [
                    {"label": "Tragende Bauteile REI 60", "status": "pass"},
                    {"label": "Zweiter Fluchtweg", "status": "needs_input"},
                ],
            }
        ]
        result = validate_cards(raw)
        assert result == raw

    def test_checklist_requires_items(self):
        raw = [{"type": "requirement_checklist", "title": "Leer", "items": []}]
        assert validate_cards(raw) == []

    def test_comparison_table_pads_and_truncates_rows(self):
        raw = [
            {
                "type": "comparison_table",
                "title": "GK 4 vs. GK 5",
                "options": ["GK 4", "GK 5"],
                "rows": [
                    {"label": "kurz", "values": ["nur GK 4"]},
                    {"label": "lang", "values": ["a", "b", "überzählig"]},
                    {"label": "highlight außerhalb", "values": ["a", "b"], "highlight_index": 5},
                ],
            }
        ]
        [card] = validate_cards(raw)
        assert card["rows"][0]["values"] == ["nur GK 4", ""]
        assert card["rows"][1]["values"] == ["a", "b"]
        # An out-of-range highlight is cleared (None) and then dropped from the dump.
        assert "highlight_index" not in card["rows"][2]

    def test_drops_none_fields(self):
        raw = [
            {
                "type": "legal_basis",
                "law": "OIB Richtlinie 2",
                "article": None,
                "section": None,
                "summary": None,
                "original_text": None,
            }
        ]
        result = validate_cards(raw)
        assert result == [{"type": "legal_basis", "law": "OIB Richtlinie 2"}]


class TestIfcViewerHighlightSelectors:
    """A highlight names a set by FILTER or names elements by id — not both.

    The id list is what the agent could write before `match` existed, and it
    stops working the moment the answer is about a set: "the 420 external
    walls" has to survive the model's context window as 420 opaque strings, so
    the card highlighted whatever fitted while the legend claimed all of it.
    """

    def _card(self, highlight: dict) -> list[dict]:
        return validate_cards(
            [
                {
                    "type": "ifc_viewer",
                    "title": "Außenwände EG",
                    "model_file": "haus-a.ifc",
                    "highlights": [highlight],
                }
            ]
        )

    def test_a_filter_is_carried_through_untouched(self):
        [card] = self._card(
            {
                "match": {
                    "ifc_types": ["IfcWall"],
                    "storeys": ["Erdgeschoss"],
                    "properties": [{"set": "Pset_WallCommon", "name": "IsExternal", "value": True}],
                },
                "label": "Außenwände",
                "status": "info",
            }
        )
        match = card["highlights"][0]["match"]
        assert match["ifc_types"] == ["IfcWall"]
        assert match["properties"][0]["name"] == "IsExternal"
        # The operator defaults rather than having to be spelled out for the
        # common case, matching the query grammar it mirrors.
        assert match["properties"][0]["operator"] == "eq"

    def test_an_id_list_still_works_for_the_few_elements_an_answer_names(self):
        [card] = self._card({"global_ids": ["1kTvXnbbzCWw8lcMd1dR4o"], "label": "T-14", "status": "fail"})
        assert card["highlights"][0]["global_ids"] == ["1kTvXnbbzCWw8lcMd1dR4o"]

    def test_a_group_with_neither_selector_is_refused(self):
        # It would render a legend entry that can never colour anything, which
        # reads as "nothing matched" rather than "this was malformed".
        assert self._card({"label": "Außenwände", "status": "info"}) == []

    def test_a_group_with_both_is_refused(self):
        # The dangerous one: the renderer would have to pick, and either choice
        # silently discards half of what the model asked for.
        assert (
            self._card(
                {
                    "global_ids": ["1kTvXnbbzCWw8lcMd1dR4o"],
                    "match": {"ifc_types": ["IfcWall"]},
                    "label": "Außenwände",
                    "status": "info",
                }
            )
            == []
        )

    def test_a_filter_copied_from_ifc_query_is_not_silently_emptied(self):
        # `ifc_query` writes camelCase (`ifcTypes`, `nameContains`) and the
        # agent is told to reuse the filter it already wrote. Without aliases
        # the card validated cleanly with every key dropped, leaving an empty
        # match and a highlight group that selects nothing — the feature
        # failing exactly the way it was meant to prevent.
        [card] = self._card(
            {
                "match": {"ifcTypes": ["IfcWall"], "nameContains": "AW", "classification": "B.1.2"},
                "label": "Außenwände",
                "status": "info",
            }
        )
        match = card["highlights"][0]["match"]
        assert match["ifc_types"] == ["IfcWall"]
        assert match["name_contains"] == "AW"
        assert match["classification"] == "B.1.2"

    def test_an_empty_match_object_is_refused(self):
        # It satisfies the exactly-one rule (a non-None match) while selecting
        # every element in the building. The frontend drops it, so the legend
        # lost an entry with no signal to the agent or the user.
        assert self._card({"match": {}, "label": "Außenwände", "status": "info"}) == []


class TestAMeasuredNumberCarriesWhereItCameFrom:
    """`DimensionCheck` used to be a number with a verdict and nothing else.

    That made the card the least honest surface in the product. `ifc_measure`
    answers „gemessen: 2.47 m (±5 mm) — aus der Geometrie berechnet, nicht
    deklariert"; the card beside it drew „2,47 m ✓", which is what a figure the
    architect had stated in their own file would look like. The card is the part
    a reviewer screenshots into a submission, so the surface that dropped the
    qualifier was the one most likely to be forwarded without it.
    """

    def test_the_three_provenances_are_the_engine_s_own(self):
        """Same three words as `ifc_spatial.envelope.Answer`, so the card and
        the sentence beside it cannot disagree about who is making the claim."""
        from aiq_agent.cards.models import DimensionCheck

        field = DimensionCheck.model_fields["provenance"]
        assert set(typing.get_args(typing.get_args(field.annotation)[0])) == {
            "declared",
            "computed",
            "inferred",
        }

    def test_a_measured_dimension_keeps_its_band(self):
        from aiq_agent.cards.models import DimensionCheck

        check = DimensionCheck(
            label="lichte Raumhöhe",
            value=2.47,
            required=2.50,
            unit="m",
            comparator=">=",
            status="fail",
            provenance="computed",
            tolerance=0.005,
        )
        assert check.provenance == "computed"
        assert check.tolerance == 0.005

    def test_all_three_are_optional_because_not_every_number_comes_from_a_model(self):
        """A limit read out of the Bestimmung has no provenance to state, and a
        null here means „not stated", never „declared"."""
        from aiq_agent.cards.models import DimensionCheck

        check = DimensionCheck(label="Mindestbreite laut OIB", required=80, unit="cm", status="needs_input")
        assert check.provenance is None
        assert check.tolerance is None
        assert check.missing is None

    def test_a_negative_band_is_refused(self):
        """A tolerance is a half-width, so it has no sign. A negative one would
        render a band that runs backwards across the limit line."""
        import pytest as _pytest
        from pydantic import ValidationError

        from aiq_agent.cards.models import DimensionCheck

        with _pytest.raises(ValidationError):
            DimensionCheck(label="x", value=1.0, status="pass", provenance="computed", tolerance=-0.1)

    def test_the_remedy_survives_onto_the_card(self):
        """The whole product thesis: an honest refusal that says what to change.

        Before this field the undecidable case reached the card as `value: null`
        and `status: 'needs_input'` — an empty slot, which reads as a fact about
        the building rather than a finding about the export.
        """
        from aiq_agent.cards.models import DimensionCheck

        check = DimensionCheck(
            label="lichte Durchgangsbreite",
            value=None,
            status="needs_input",
            missing="Die Tür trägt kein IfcOpeningElement mit Geometrie — im CAD als Öffnung modellieren.",
        )
        assert "im CAD" in (check.missing or "")


class TestAnswerShapeCards:
    """The four cards that render the answer's shape rather than a schematic:
    verdict_header, condition_tree, typed_table and norm_chain.

    Each is checked twice — a valid card the adapter routes to its model, and one
    malformed variant the validator rejects — plus the worked example, which is
    what the model actually copies, is confirmed to round-trip.
    """

    def test_verdict_header_validates_and_routes(self):
        from aiq_agent.cards.models import VerdictHeaderCard

        raw = {
            "type": "verdict_header",
            "verdict": "1,10 m",
            "subject": "Erforderliche Geländerhöhe",
            "reference": {"document": "OIB-Richtlinie 4", "section": "Pkt. 4.3"},
            "confidence": "high",
        }
        card = grid_card_adapter.validate_python(raw)
        assert isinstance(card, VerdictHeaderCard)
        assert card.verdict == "1,10 m"
        assert card.confidence == "high"

    def test_verdict_header_rejects_empty_verdict(self):
        # The verdict IS the card — an empty one would render a header with no
        # answer under it, worse than no card at all.
        assert validate_cards([{"type": "verdict_header", "verdict": "", "subject": "Geländerhöhe"}]) == []

    def test_condition_tree_validates_and_marks_the_active_branch(self):
        from aiq_agent.cards.models import ConditionTreeCard

        raw = {
            "type": "condition_tree",
            "title": "Erforderliche Feuerwiderstandsklasse",
            "question": "Gebäudeklasse",
            "branches": [
                {"condition": "GK 1–3", "outcome": "REI 30"},
                {"condition": "GK 4", "outcome": "REI 60", "active": True},
            ],
        }
        card = grid_card_adapter.validate_python(raw)
        assert isinstance(card, ConditionTreeCard)
        assert card.branches[1].active is True

    def test_condition_tree_requires_at_least_one_branch(self):
        raw = {"type": "condition_tree", "title": "Leer", "question": "Gebäudeklasse", "branches": []}
        assert validate_cards([raw]) == []

    def test_typed_table_squares_rows_to_the_column_count(self):
        # Mirrors ComparisonTableCard: a short row is padded, an overlong one
        # truncated, so a row/column mismatch never drops the whole table.
        raw = {
            "type": "typed_table",
            "title": "Mindestmaße",
            "columns": [
                {"label": "Bauteil", "type": "text"},
                {"label": "Maß", "type": "mass"},
                {"label": "Erfüllt", "type": "verdict"},
            ],
            "rows": [
                ["Tür", "90 cm"],  # short -> padded with ""
                ["Rampe", "6 %", "nicht erfüllt", "überzählig"],  # long -> truncated
            ],
        }
        [card] = validate_cards([raw])
        assert card["rows"][0] == ["Tür", "90 cm", ""]
        assert card["rows"][1] == ["Rampe", "6 %", "nicht erfüllt"]

    def test_typed_table_rejects_an_unknown_column_type(self):
        raw = {
            "type": "typed_table",
            "title": "Mindestmaße",
            "columns": [{"label": "Maß", "type": "distance"}],
            "rows": [["90 cm"]],
        }
        assert validate_cards([raw]) == []

    def test_norm_chain_validates_and_keeps_link_order(self):
        from aiq_agent.cards.models import NormChainCard

        raw = {
            "type": "norm_chain",
            "title": "Normenkette – Absturzsicherung",
            "links": [
                {"label": "Wiener Bautechnikverordnung", "rank": "verordnung"},
                {"label": "OIB-Richtlinie 4", "rank": "oib_richtlinie"},
                {"label": "ÖNORM B 1600", "rank": "oenorm"},
            ],
        }
        card = grid_card_adapter.validate_python(raw)
        assert isinstance(card, NormChainCard)
        assert [link.rank for link in card.links] == ["verordnung", "oib_richtlinie", "oenorm"]

    def test_norm_chain_rejects_a_rank_outside_the_vocabulary(self):
        # The rank drives the binding-vs-interpretive weight in the render; a
        # freeform string would render with no weight and no meaning.
        raw = {
            "type": "norm_chain",
            "title": "Kette",
            "links": [{"label": "EU-Verordnung", "rank": "eu_verordnung"}],
        }
        assert validate_cards([raw]) == []

    def test_the_worked_examples_round_trip(self):
        from aiq_agent.cards.catalog import CARD_EXAMPLES

        for card_type in ("verdict_header", "condition_tree", "typed_table", "norm_chain"):
            card = grid_card_adapter.validate_python(CARD_EXAMPLES[card_type])
            assert card.type == card_type

    def test_render_card_details_covers_each_new_type(self):
        from aiq_agent.cards.catalog import render_card_details

        detail = render_card_details(["verdict_header", "condition_tree", "typed_table", "norm_chain"])
        for card_type in ("verdict_header", "condition_tree", "typed_table", "norm_chain"):
            assert f'"{card_type}"' in detail
        # The nested building blocks are spelled out, not hidden behind a name.
        assert "ConditionBranch = {" in detail
        assert "NormChainLink = {" in detail
        # The worked examples ride along so the model copies the nesting exactly.
        assert "Worked examples" in detail


class TestGenericPolishCards:
    """The two cards that carry no domain: key_takeaways and callout.

    They are the ones an ORDINARY answer can use, so the constraints under test
    are the ones that keep them from degenerating back into prose: a takeaway
    block that is neither a sentence nor the answer again, and a callout whose
    kind is a closed vocabulary the renderer can name in words.
    """

    def test_key_takeaways_validates_and_keeps_the_detail_behind_each_item(self):
        from aiq_agent.cards.models import KeyTakeawaysCard

        raw = {
            "type": "key_takeaways",
            "title": "Gebäudeklasse 4 – das Wichtigste",
            "items": [
                {"text": "Fluchtniveau 9,80 m → Gebäudeklasse 4", "detail": "Die Grenze zu GK 5 liegt bei 11 m."},
                {"text": "Tragende Bauteile mindestens REI 60"},
            ],
        }
        card = grid_card_adapter.validate_python(raw)
        assert isinstance(card, KeyTakeawaysCard)
        assert card.items[0].detail is not None
        # A takeaway with nothing behind it stays without one — the renderer
        # gives it no expander, so an empty string here would be a dead click.
        assert card.items[1].detail is None

    def test_key_takeaways_rejects_one_item_and_six(self):
        # One takeaway is a sentence and belongs in the prose; six is the answer
        # written twice, which is the failure mode a bullet list already has.
        one = {"type": "key_takeaways", "items": [{"text": "Gebäudeklasse 4"}]}
        six = {"type": "key_takeaways", "items": [{"text": f"Punkt {i}"} for i in range(6)]}
        assert validate_cards([one, six]) == []

    def test_key_takeaways_needs_no_title(self):
        raw = {"type": "key_takeaways", "items": [{"text": "Erster Punkt"}, {"text": "Zweiter Punkt"}]}
        [card] = validate_cards([raw])
        assert "title" not in card

    def test_callout_validates_each_kind(self):
        from aiq_agent.cards.models import CalloutCard

        for kind in ("hinweis", "achtung", "frist", "tipp"):
            card = grid_card_adapter.validate_python({"type": "callout", "kind": kind, "text": "Ein Hinweis."})
            assert isinstance(card, CalloutCard)
            assert card.kind == kind

    def test_callout_rejects_a_kind_outside_the_vocabulary(self):
        # The kind drives both the tone AND the word the renderer prints; a
        # freeform one would render an unlabelled coloured box.
        assert validate_cards([{"type": "callout", "kind": "warnung", "text": "Achtung."}]) == []

    def test_callout_rejects_an_empty_remark(self):
        # The remark IS the card — an empty one is a frame around nothing.
        assert validate_cards([{"type": "callout", "kind": "hinweis", "text": ""}]) == []

    def test_the_worked_examples_round_trip(self):
        from aiq_agent.cards.catalog import CARD_EXAMPLES

        for card_type in ("key_takeaways", "callout"):
            card = grid_card_adapter.validate_python(CARD_EXAMPLES[card_type])
            assert card.type == card_type

    def test_render_card_details_spells_out_the_takeaway_block(self):
        from aiq_agent.cards.catalog import render_card_details

        detail = render_card_details(["key_takeaways", "callout"])
        assert '"key_takeaways"' in detail and '"callout"' in detail
        assert "KeyTakeaway = {" in detail


class TestTheCatalogTellsTheModelToCopyNotGuess:
    """The rule has to be stated where the model reads the catalog.

    Field descriptions carry it too, but a card outlives the sentence next to
    it, and „copy the provenance, never infer it" is the kind of instruction
    that has to be impossible to miss.
    """

    def test_the_measured_note_is_in_the_catalog_body(self):
        from aiq_agent.cards.catalog import render_card_catalog

        body = render_card_catalog()
        assert "ifc_measure" in body
        assert "provenance" in body and "tolerance" in body
        # The two failure modes it exists to prevent, named.
        assert "never infer them" in body
        assert "missing.remedy" in body
