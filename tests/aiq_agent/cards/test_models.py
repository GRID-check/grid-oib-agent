"""Tests for Grid card models."""

import typing

from pydantic import ValidationError

from aiq_agent.cards.models import CardModel
from aiq_agent.cards.models import GridCard
from aiq_agent.cards.models import MemoryProposalCard
from aiq_agent.cards.models import flatten_card_markup
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

    def test_drops_unknown_card_type(self):
        raw = [{"type": "unknown_type", "title": "Unknown"}]
        assert validate_cards(raw) == []

    def test_drops_card_missing_required_field(self):
        raw = [{"type": "calculation"}]
        assert validate_cards(raw) == []

    def test_keeps_valid_cards_and_drops_invalid_in_same_batch(self):
        raw = [
            {"type": "ifc_model_picker", "title": "Good"},
            {"type": "ifc_model_picker"},  # missing required title -> dropped
            {"type": "ifc_model_picker", "title": "Also good", "note": "Ein Klick öffnet das Modell."},
        ]
        result = validate_cards(raw)
        assert result == [
            {"type": "ifc_model_picker", "title": "Good"},
            {"type": "ifc_model_picker", "title": "Also good", "note": "Ein Klick öffnet das Modell."},
        ]

    def test_drops_none_fields(self):
        raw = [{"type": "ifc_model_picker", "title": "Welches Modell?", "note": None}]
        result = validate_cards(raw)
        assert result == [{"type": "ifc_model_picker", "title": "Welches Modell?"}]


class TestIfcViewerHighlightSelectors:
    """A highlight names a set by FILTER or names elements by id — not both.

    The id list stops working the moment the answer is about a set: "the 420
    external walls" has to survive the model's context window as 420 opaque strings, so
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
        # the card validates cleanly with every key dropped, leaving an empty
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
    """`DimensionCheck` carries its provenance, not just a number and a verdict.

    Without it the card is the least honest surface in the product. `ifc_measure`
    answers „gemessen: 2.47 m (±5 mm) — aus der Geometrie berechnet, nicht
    deklariert"; a card beside it that drew „2,47 m ✓" would look like a figure the
    architect had stated in their own file. The card is the part a reviewer
    screenshots into a submission, so the surface that drops the qualifier is the
    one most likely to be forwarded without it.
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

        from aiq_agent.cards.models import DimensionCheck

        with _pytest.raises(ValidationError):
            DimensionCheck(label="x", value=1.0, status="pass", provenance="computed", tolerance=-0.1)

    def test_the_remedy_survives_onto_the_card(self):
        """The whole product thesis: an honest refusal that says what to change.

        Without this field the undecidable case reaches the card as `value: null`
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


class TestTheCalculationCardCannotStateItsOwnAnswer:
    """The card's honesty rests on what the schema does NOT have.

    `calculation` is the one card whose payload is the INPUT to an arithmetic
    the renderer performs. If the model could state a result, a Rechenweg whose
    result disagreed with its own operands would validate happily — and that is
    the artefact that gets screenshotted into an Einreichung. So the absence of
    a result field is a property worth asserting, not an implementation detail.
    """

    def _schrittmass(self) -> dict:
        return {
            "type": "calculation",
            "title": "Schrittmaßregel – Treppenlauf Haus A",
            "steps": [
                {
                    "label": "Schrittmaß",
                    "operation": "sum",
                    "unit": "cm",
                    "operands": [
                        {"label": "Steigung", "value": 17.0, "unit": "cm", "factor": 2},
                        {"label": "Auftritt", "value": 30.0, "unit": "cm"},
                    ],
                }
            ],
            "limit": {"comparator": "between", "value": 59, "upper": 65},
        }

    def test_no_field_anywhere_lets_the_model_state_a_result(self):
        from aiq_agent.cards.models import CalculationCard
        from aiq_agent.cards.models import CalculationLimit
        from aiq_agent.cards.models import CalculationStep

        for model in (CalculationCard, CalculationStep, CalculationLimit):
            assert not {"result", "value", "total", "outcome"} & set(model.model_fields) - {"value"}
        # `CalculationLimit.value` is the BOUND, which is read out of the
        # Bestimmung — the one number on this card the model is meant to supply.
        assert "value" not in CalculationStep.model_fields
        assert "value" not in CalculationCard.model_fields

    def test_a_stated_result_does_not_survive_validation(self):
        raw = self._schrittmass()
        raw["steps"][0]["result"] = 999.0
        [card] = validate_cards([raw])
        assert "result" not in card["steps"][0], "a model-supplied result must not reach the renderer"

    def test_the_five_operations_are_the_whole_vocabulary(self):
        from aiq_agent.cards.models import CalculationStep

        operation = CalculationStep.model_fields["operation"].annotation
        assert set(typing.get_args(operation)) == {"sum", "product", "quotient", "percent_of", "percent_ratio"}

    def test_the_fixed_arity_operations_reject_a_third_operand(self):
        # A quotient of three numbers has no unambiguous reading, and guessing
        # one is exactly the parse this card exists to avoid.
        for operation in ("quotient", "percent_of", "percent_ratio"):
            raw = self._schrittmass()
            raw["steps"][0]["operation"] = operation
            raw["steps"][0]["operands"].append({"label": "Drittes", "value": 1.0})
            assert validate_cards([raw]) == [], operation

    def test_a_factor_belongs_only_to_a_sum(self):
        # `factor` is the RULE's own multiplier. On a product it would be a
        # second measured quantity smuggled in without a label of its own.
        raw = self._schrittmass()
        raw["steps"][0]["operation"] = "product"
        assert validate_cards([raw]) == []

    def test_a_step_reference_must_point_backwards(self):
        raw = self._schrittmass()
        raw["steps"][0]["operands"][0] = {"label": "Rges", "step": 1}
        assert validate_cards([raw]) == [], "a self reference has no value to read"

        forward = self._schrittmass()
        forward["steps"][0]["operands"][0] = {"label": "Rges", "step": 2}
        assert validate_cards([forward]) == []

    def test_a_reference_carries_no_value_of_its_own(self):
        # Two answers to the same question; the renderer would have to pick one.
        raw = self._schrittmass()
        raw["steps"].append(
            {
                "label": "U-Wert",
                "operation": "quotient",
                "operands": [{"label": "", "value": 1.0}, {"label": "Rges", "step": 1, "value": 4.0}],
            }
        )
        assert validate_cards([raw]) == []

    def test_a_bare_constant_may_go_unlabelled_but_a_quantity_may_not(self):
        # The 1 in a U-value's 1 ÷ R names itself. Everything a reader has to
        # look up gets its name under it in the derivation line, so the field
        # stays required — it is only the min-length that gives way.
        from aiq_agent.cards.models import CalculationOperand

        assert CalculationOperand.model_fields["label"].is_required()
        assert CalculationOperand(label="", value=1.0).label == ""

    def test_a_two_step_derivation_chains_by_reference(self):
        raw = {
            "type": "calculation",
            "title": "U-Wert Außenwand",
            "steps": [
                {
                    "label": "Wärmedurchgangswiderstand",
                    "operation": "sum",
                    "unit": "m²K/W",
                    "operands": [
                        {"label": "Rsi", "value": 0.13, "unit": "m²K/W"},
                        {"label": "Dämmung", "value": 3.5, "unit": "m²K/W"},
                    ],
                },
                {
                    "label": "U-Wert",
                    "operation": "quotient",
                    "unit": "W/(m²K)",
                    "operands": [{"label": "", "value": 1.0}, {"label": "Rges", "step": 1}],
                },
            ],
        }
        [card] = validate_cards([raw])
        assert card["steps"][1]["operands"][1]["step"] == 1

    def test_a_range_limit_needs_both_bounds_the_right_way_round(self):
        for limit in (
            {"comparator": "between", "value": 59},
            {"comparator": "between", "value": 65, "upper": 59},
            {"comparator": "<=", "value": 65, "upper": 70},
        ):
            raw = self._schrittmass()
            raw["limit"] = limit
            assert validate_cards([raw]) == [], limit

    def test_the_worked_example_round_trips(self):
        from aiq_agent.cards.catalog import CARD_EXAMPLES

        card = grid_card_adapter.validate_python(CARD_EXAMPLES["calculation"])
        assert card.type == "calculation"
        # The example has to SHOW the provenance vocabulary, not just allow it —
        # a derived number is only as honest as the inputs it was built from.
        assert card.steps[0].operands[0].provenance == "computed"
        assert card.steps[0].operands[0].tolerance == 0.5

    def test_render_card_details_spells_out_the_nested_blocks(self):
        from aiq_agent.cards.catalog import render_card_details

        detail = render_card_details(["calculation"])
        assert '"calculation"' in detail
        assert "CalculationStep = {" in detail
        assert "CalculationOperand = {" in detail
        assert "CalculationLimit = {" in detail


class TestBothNewCardsAreInTheDoctrineAndNotInTheCraft:
    def test_the_craft_is_not_paid_for_on_every_turn(self):
        # Same rule the follow_ups trigger follows: the trigger is the tool's
        # contract, and what makes a card WORTH emitting belongs in the
        # `piloti-cards` skill, which is a database row rather than a deploy.
        from aiq_agent.cards.register import _CARD_DOCTRINE

        assert "Ziviltechniker" not in _CARD_DOCTRINE
        assert "renderer" not in _CARD_DOCTRINE


class TestCardTextIsPlainText:
    """No card renders markup, so no card field may carry any.

    The defect these pin: a card puts
    „[OIB-Richtlinie ansehen](https://www.oib.or.at/de/oib-richtlinien)“ on
    screen as literal brackets, beside the card's own working link to that same
    page. The contract is not written down anywhere, so nothing enforces it.

    Sanitising happens on the way IN, never in the renderer. A card is what gets
    screenshotted into an Einreichung; a renderer that parsed markdown in a field
    nobody declared as markdown would let the model put an arbitrary link into a
    legal citation.
    """

    def test_the_shipped_defect_reaches_the_card_as_text(self):
        card = grid_card_adapter.validate_python(
            {
                "type": "ifc_model_picker",
                "title": "Modell",
                "note": "Details: [OIB-Richtlinie ansehen](https://www.oib.or.at/de/oib-richtlinien)",
            }
        )
        assert card.note == "Details: OIB-Richtlinie ansehen (https://www.oib.or.at/de/oib-richtlinien)"

    def test_the_url_survives_as_text_rather_than_being_dropped(self):
        # Silently deleting half of what a citation asserted is the one thing a
        # sanitiser on this surface must not do. The brackets go; the target
        # stays, as text — nothing downstream turns a bare URL in a card field
        # into an anchor, so the card gains no link it did not already build.
        card = grid_card_adapter.validate_python(
            {"type": "ifc_model_picker", "title": "X", "note": "siehe [§ 3](https://ris.bka.gv.at/x)"}
        )
        assert "https://ris.bka.gv.at/x" in card.note
        assert "[" not in card.note
        assert "](" not in card.note

    def test_doubled_emphasis_and_code_spans_lose_their_delimiters(self):
        card = grid_card_adapter.validate_python(
            {"type": "ifc_model_picker", "title": "**OIB-Richtlinie 2**", "note": "Mindestens `REI 90`."}
        )
        assert card.title == "OIB-Richtlinie 2"
        assert card.note == "Mindestens REI 90."

    def test_single_character_emphasis_is_left_alone(self):
        # A lone `*` is a footnote marker in an OIB table and `_` is ordinary
        # punctuation in a file reference; the line is drawn at delimiters that
        # have no second reading.
        excerpt = "Die Anforderung *) gilt sinngemäß für Anlage_1."
        card = grid_card_adapter.validate_python({"type": "ifc_model_picker", "title": "X", "note": excerpt})
        assert card.note == excerpt

    def test_it_is_the_class_and_not_just_one_card(self):
        # Same markup, a different card and a nested building block: the guard
        # is on the shared base, so it is not a per-card patch.
        card = grid_card_adapter.validate_python(
            {
                "type": "building_section",
                "title": "**Schnitt**",
                "storeys": [{"label": "`EG`", "height_m": 3.0}],
                "reference": {"document": "Siehe [RIS](https://ris.bka.gv.at)"},
            }
        )
        assert card.title == "Schnitt"
        assert card.storeys[0].label == "EG"
        assert card.reference.document == "Siehe RIS (https://ris.bka.gv.at)"

    def test_every_card_type_inherits_the_guarantee(self):
        # The point of putting it on a base class: a card type added later
        # is covered by BEING a card, not by someone remembering to annotate its
        # fields. 177 free-text fields across 71 models is 177 chances to forget.
        for card_cls in GridCard.__args__:
            assert issubclass(card_cls, CardModel), card_cls.__name__

    def test_flattening_is_idempotent_and_leaves_plain_text_untouched(self):
        plain = "OIB-Richtlinie 2, Ausgabe Mai 2023 — § 3 Abs. 1 (Brandschutz)."
        assert flatten_card_markup(plain) == plain
        once = flatten_card_markup("[a](https://x) **b** `c`")
        assert flatten_card_markup(once) == once
