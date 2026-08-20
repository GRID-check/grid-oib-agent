"""Tests for Grid card models."""

import typing

import pytest
from pydantic import ValidationError

from aiq_agent.cards.models import CardModel
from aiq_agent.cards.models import GridCard
from aiq_agent.cards.models import LegalBasisCard
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


class TestFollowUpsCard:
    """The card whose payload is USER INPUT: each question is prefilled verbatim.

    Every constraint here exists because the `question` string does not get
    rendered and forgotten — it lands in the composer as the text the user is
    about to send. So it must be sendable as it stands, and the set must be a
    set: two to four, because one chip is not a choice and five is a menu the
    reader has to work through instead of an offer they can take.

    The card is RETIRED (`SYSTEM_CARD_TYPES`; see `test_follow_ups_retired.py`)
    and this suite is what makes the retirement survivable: the model may not
    emit a new one, and every one already stored keeps parsing to exactly this
    shape on every render. So these assertions go through `grid_card_adapter`,
    the adapter the read path uses, and NOT through `validate_cards`, which is a
    model-output path and now drops the type before a single field is looked at.
    Asserting a rejection through `validate_cards` would pass for the wrong
    reason and stop testing the shape at all.
    """

    def test_follow_ups_validates_and_keeps_the_hint_optional(self):
        from aiq_agent.cards.models import FollowUpsCard

        raw = {
            "type": "follow_ups",
            "title": "Weiterführende Fragen",
            "items": [
                {"question": "Wie wird das Fluchtniveau genau gemessen?", "hint": "Messpunkt und Bezugsebene"},
                {"question": "Was wäre bei Gebäudeklasse 5 anders?"},
            ],
        }
        card = grid_card_adapter.validate_python(raw)
        assert isinstance(card, FollowUpsCard)
        assert card.items[0].hint == "Messpunkt und Bezugsebene"
        # No hint means no tooltip — an empty string would render an empty one.
        assert card.items[1].hint is None

    def test_follow_ups_rejects_one_question_and_five(self):
        # One chip is not a set of next steps, it is the answer picking the
        # reader's next question for them; five is a menu, and the reader has to
        # read all of it before they can take any of it.
        one = {"type": "follow_ups", "items": [{"question": "Und dann?"}]}
        five = {"type": "follow_ups", "items": [{"question": f"Frage {i}?"} for i in range(5)]}
        for raw in (one, five):
            with pytest.raises(ValidationError):
                grid_card_adapter.validate_python(raw)

    def test_follow_ups_rejects_an_empty_question(self):
        # The question IS the payload: an empty one prefills the composer with
        # nothing and the chip becomes a click that appears to do nothing.
        raw = {"type": "follow_ups", "items": [{"question": ""}, {"question": "Was gilt in Wien?"}]}
        with pytest.raises(ValidationError):
            grid_card_adapter.validate_python(raw)

    def test_follow_ups_needs_no_title(self):
        raw = {"type": "follow_ups", "items": [{"question": "Erste Frage?"}, {"question": "Zweite Frage?"}]}
        card = grid_card_adapter.validate_python(raw).model_dump(exclude_none=True)
        assert "title" not in card

    def test_the_worked_example_round_trips_and_shows_four_different_moves(self):
        from aiq_agent.cards.catalog import CARD_EXAMPLES

        card = grid_card_adapter.validate_python(CARD_EXAMPLES["follow_ups"])
        assert card.type == "follow_ups"
        # The example is the only place the model sees what "diverse" means, so
        # it has to BE diverse — four rewordings of one question would validate
        # just as happily and would teach exactly the wrong shape.
        questions = [item.question for item in card.items]
        assert len(set(questions)) == len(questions)
        assert all(q.endswith("?") for q in questions), "each question is sent as written"

    def test_the_shape_is_no_longer_handed_to_the_model(self):
        # `render_card_details` is `describe_card` and the skills substrate's
        # `grid-cards` block. It spelled the `FollowUp` block out while the card
        # was model-facing; now that the card is retired, handing the shape back
        # would be the one way a skill author could put it into context again.
        # The read path is unaffected — the tests above validate the same shape
        # through `grid_card_adapter`, which is what a stored card goes through.
        from aiq_agent.cards.catalog import render_card_details

        assert render_card_details(["follow_ups"]) == ""

    def test_the_doctrine_no_longer_carries_its_trigger_or_its_rule(self):
        # The trigger and the placement rule were the TOOL's contract, paid on
        # every turn. The stage carries what they said now — the two exceptions
        # became gate conditions — so what is left here is only the cost, and the
        # cost of describing a card the model may not emit is the whole cost.
        from aiq_agent.cards.register import _CARD_DOCTRINE

        assert "follow_ups" not in _CARD_DOCTRINE
        assert "closes a subject-matter answer by default" not in _CARD_DOCTRINE
        assert "conversational or off-topic" not in _CARD_DOCTRINE
        # The craft paragraphs were never here and must not arrive now.
        assert "NAME something" not in _CARD_DOCTRINE
        assert "DIFFERENT KINDS" not in _CARD_DOCTRINE


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


class TestTheProcessMapMarksOnePositionOrNone:
    """`current_step` is the model's ONE positional claim; the rest is derived.

    A map that quietly defaults to step 1 tells a reader they have a
    Baubewilligung they may not have, so an absent or out-of-range position has
    to stay absent all the way through.
    """

    def _verfahren(self, **overrides) -> dict:
        raw = {
            "type": "process_map",
            "title": "Baubewilligungsverfahren – Wien",
            "steps": [
                {"label": "Einreichung", "requires": ["Einreichplan"], "produces": ["Aktenzeichen"]},
                {"label": "Bauverhandlung", "duration": "binnen sechs Wochen"},
                {"label": "Baubewilligung", "produces": ["Baubewilligungsbescheid"]},
            ],
        }
        raw.update(overrides)
        return raw

    def test_validates_with_a_marked_position(self):
        [card] = validate_cards([self._verfahren(current_step=2)])
        assert card["current_step"] == 2
        assert card["steps"][0]["requires"] == ["Einreichplan"]

    def test_an_unmarked_map_stays_unmarked(self):
        # `validate_cards` drops nulls, and the frontend schema defaults the
        # field back to null — what must never happen is a position appearing
        # where the model stated none.
        [card] = validate_cards([self._verfahren()])
        assert "current_step" not in card

    def test_a_position_outside_the_procedure_is_rejected_not_clamped(self):
        # Clamping would silently move the reader to a step they are not at.
        assert validate_cards([self._verfahren(current_step=0)]) == []
        assert validate_cards([self._verfahren(current_step=4)]) == []

    def test_two_steps_is_not_a_procedure_and_nine_is_a_flowchart(self):
        two = self._verfahren(steps=[{"label": "Einreichung"}, {"label": "Bescheid"}])
        nine = self._verfahren(steps=[{"label": f"Schritt {i}"} for i in range(9)])
        assert validate_cards([two, nine]) == []

    def test_a_duration_is_written_never_computed(self):
        # The Frist is a string on purpose: a date this card worked out would be
        # a legal statement about the reader's project.
        from aiq_agent.cards.models import ProcessStep

        assert ProcessStep.model_fields["duration"].annotation == str | None

    def test_the_worked_example_round_trips_and_opens_onto_something(self):
        from aiq_agent.cards.catalog import CARD_EXAMPLES

        card = grid_card_adapter.validate_python(CARD_EXAMPLES["process_map"])
        assert card.type == "process_map"
        # A map whose steps carry only labels is the numbered list it replaces,
        # and the click then opens onto nothing.
        assert any(step.requires or step.produces for step in card.steps)
        assert any(step.reference for step in card.steps)


class TestBothNewCardsAreInTheDoctrineAndNotInTheCraft:
    def test_each_has_a_trigger_line(self):
        from aiq_agent.cards.register import _CARD_DOCTRINE

        assert "-> calculation" in _CARD_DOCTRINE
        assert "-> process_map" in _CARD_DOCTRINE

    def test_the_craft_is_not_paid_for_on_every_turn(self):
        # Same rule the follow_ups trigger follows: the trigger is the tool's
        # contract, and what makes a card WORTH emitting belongs in the
        # `piloti-cards` skill, which is a database row rather than a deploy.
        from aiq_agent.cards.register import _CARD_DOCTRINE

        assert "Ziviltechniker" not in _CARD_DOCTRINE
        assert "renderer" not in _CARD_DOCTRINE


class TestAForkMarksAtMostOneCase:
    """The field failure this validator exists for.

    „Welche Feuerwiderstandsklasse brauchen tragende Bauteile in GK 4?" came
    back as a `condition_tree` with all three branches `active` — oberstes
    Geschoß R 60, sonstiges Geschoß R 60, unterirdisches Geschoß R 90 und A2 —
    and the opened one read „FÜR DIESES PROJEKT GILT: R 60". Three simultaneous
    answers, each captioned as the one that applies. Nothing stopped it, and it
    looks like a decision was made when none was, which is worse than no card.

    Those three rows are not a fork at all: all of them are true at once, of
    different parts of the same building. The message therefore has to say more
    than „invalid" — `emit_card` shows it back to the model, so it names the
    card the content actually wants.
    """

    @staticmethod
    def _tree(**overrides):
        raw = {
            "type": "condition_tree",
            "title": "Erforderliche Feuerwiderstandsklasse",
            "question": "Gebäudeklasse",
            "branches": [
                {"condition": "GK 1–3", "outcome": "REI 30"},
                {"condition": "GK 4", "outcome": "REI 60"},
                {"condition": "GK 5", "outcome": "REI 90"},
            ],
        }
        raw.update(overrides)
        return raw

    def test_one_marked_case_is_the_normal_shape(self):
        branches = [
            {"condition": "GK 1–3", "outcome": "REI 30"},
            {"condition": "GK 4", "outcome": "REI 60", "active": True},
        ]
        [card] = validate_cards([self._tree(branches=branches)])
        assert [b.get("active") for b in card["branches"]] == [None, True]

    def test_no_marked_case_is_also_fine(self):
        # Not knowing which case applies is a state the card renders honestly;
        # it is guessing that is forbidden, not abstaining.
        [card] = validate_cards([self._tree()])
        assert not any(b.get("active") for b in card["branches"])

    def test_two_marked_cases_are_rejected(self):
        branches = [
            {"condition": "oberstes oberirdisches Geschoß", "outcome": "R 60", "active": True},
            {"condition": "sonstiges oberirdisches Geschoß", "outcome": "R 60", "active": True},
            {"condition": "unterirdisches Geschoß", "outcome": "R 90 und A2", "active": True},
        ]
        assert validate_cards([self._tree(branches=branches)]) == []

    def test_the_error_names_typed_table_so_the_retry_can_act_on_it(self):
        import pytest

        from aiq_agent.cards.models import ConditionTreeCard

        branches = [
            {"condition": "oberstes oberirdisches Geschoß", "outcome": "R 60", "active": True},
            {"condition": "unterirdisches Geschoß", "outcome": "R 90 und A2", "active": True},
        ]
        with pytest.raises(ValueError) as excinfo:
            ConditionTreeCard.model_validate(self._tree(branches=branches))

        message = str(excinfo.value)
        # The useful half of the message is not that it is invalid but which
        # card the content wants instead, and which branches collided.
        assert "typed_table" in message
        assert "oberstes oberirdisches Geschoß" in message
        assert "unterirdisches Geschoß" in message

    def test_the_doctrine_states_the_test_rather_than_only_the_topic(self):
        from aiq_agent.cards.register import _CARD_DOCTRINE

        # A trigger line the model can APPLY: cases that exclude each other, at
        # most one of them marked — and the escape hatch for rows that do not.
        assert "exclude each other" in _CARD_DOCTRINE
        assert "all true at once" in _CARD_DOCTRINE


class TestTheEinreichlisteCarriesStateNotNames:
    """`document_checklist` — the answer to „was brauche ich für die Einreichung"."""

    @staticmethod
    def _liste(**overrides):
        raw = {
            "type": "document_checklist",
            "title": "Einreichunterlagen – Neubau Wien",
            "items": [
                {"label": "Einreichplan", "requirement": "required", "issuer": "Ziviltechniker:in"},
                {
                    "label": "Grundbuchsauszug",
                    "requirement": "conditional",
                    "condition": "nur wenn der Bauwerber nicht Eigentümer ist",
                },
            ],
        }
        raw.update(overrides)
        return raw

    def test_validates_and_keeps_the_reading_order(self):
        from aiq_agent.cards.models import DocumentChecklistCard

        card = grid_card_adapter.validate_python(self._liste())
        assert isinstance(card, DocumentChecklistCard)
        assert [item.label for item in card.items] == ["Einreichplan", "Grundbuchsauszug"]

    def test_a_conditional_document_must_say_on_what(self):
        # The whole point of marking a document conditional is that the reader
        # can tell whether it applies to them. Without the condition it is the
        # markdown list again, and the card would be claiming to add what it
        # does not add.
        items = [
            {"label": "Einreichplan", "requirement": "required"},
            {"label": "Grundbuchsauszug", "requirement": "conditional"},
        ]
        assert validate_cards([self._liste(items=items)]) == []

    def test_an_always_required_document_carries_no_condition(self):
        items = [
            {"label": "Einreichplan", "requirement": "required", "condition": "nur bei Neubau"},
            {"label": "Baubeschreibung", "requirement": "required"},
        ]
        assert validate_cards([self._liste(items=items)]) == []

    def test_an_unstated_status_stays_unstated(self):
        # The one claim this card makes about the READER's project. Absent has
        # to survive validation as absent — the renderer draws it as unknown,
        # and a default of 'missing' would tell someone their dossier is behind.
        [card] = validate_cards([self._liste()])
        assert all("status" not in item for item in card["items"])

    def test_the_card_carries_no_totals_for_a_renderer_to_contradict(self):
        from aiq_agent.cards.models import DocumentChecklistCard

        # Same invariant as `calculation`: the tally („3 erforderlich, 1
        # vorhanden, 3 ungeklärt") is derived in the component from the rows,
        # so there is no field here for a stated count to disagree with.
        fields = set(DocumentChecklistCard.model_fields)
        assert not fields & {"count", "total", "required_count", "progress", "complete"}

    def test_one_document_is_a_sentence_and_seventeen_is_a_form(self):
        one = self._liste(items=[{"label": "Einreichplan", "requirement": "required"}])
        many = self._liste(items=[{"label": f"Beilage {i}", "requirement": "required"} for i in range(17)])
        assert validate_cards([one, many]) == []

    def test_the_worked_example_round_trips_and_shows_both_halves(self):
        from aiq_agent.cards.catalog import CARD_EXAMPLES

        card = grid_card_adapter.validate_python(CARD_EXAMPLES["document_checklist"])
        assert card.type == "document_checklist"
        # The example has to teach BOTH: a document whose status the
        # conversation settled, and — in the majority — documents whose status
        # it did not. An example answering every row teaches answering every row.
        assert any(item.status is not None for item in card.items)
        assert sum(item.status is None for item in card.items) > sum(item.status is not None for item in card.items)
        assert any(item.requirement == "conditional" and item.condition for item in card.items)


class TestAFristIsCarriedAsWrittenNeverAsADate:
    """`deadline_timeline` — several clocks, each running from its own event."""

    @staticmethod
    def _fristen(**overrides):
        raw = {
            "type": "deadline_timeline",
            "title": "Fristen im Bauverfahren – Wien",
            "deadlines": [
                {
                    "label": "Beschwerdefrist",
                    "period": "binnen vier Wochen",
                    "starts_from": "ab Zustellung des Bescheids",
                    "consequence": "Der Bescheid wird rechtskräftig.",
                },
                {
                    "label": "Fertigstellungsanzeige",
                    "period": "unverzüglich",
                    "starts_from": "ab Fertigstellung des Bauvorhabens",
                },
            ],
        }
        raw.update(overrides)
        return raw

    def test_validates_and_keeps_the_sequence(self):
        from aiq_agent.cards.models import DeadlineTimelineCard

        card = grid_card_adapter.validate_python(self._fristen())
        assert isinstance(card, DeadlineTimelineCard)
        assert [d.label for d in card.deadlines] == ["Beschwerdefrist", "Fertigstellungsanzeige"]

    def test_a_frist_without_its_trigger_cannot_be_built(self):
        # A period nobody can place is not usable, and a reader who assumes the
        # wrong trigger misses the Frist by the gap between the two events. The
        # field is required so the answer omits the Frist rather than floating it.
        from aiq_agent.cards.models import Deadline

        assert Deadline.model_fields["starts_from"].is_required()

    def test_a_computed_calendar_date_is_rejected_in_either_field(self):
        # The product does not know this project's Zustelldatum, so any date
        # here was worked out from nothing. Both the German and the ISO spelling.
        for bad in ("bis 14.03.2026", "bis 14. 3. 2026", "bis 2026-03-14"):
            assert (
                validate_cards(
                    [
                        self._fristen(
                            deadlines=[
                                {"label": "Beschwerdefrist", "period": bad, "starts_from": "ab Zustellung"},
                                {"label": "Anzeige", "period": "unverzüglich", "starts_from": "ab Fertigstellung"},
                            ]
                        )
                    ]
                )
                == []
            )
            assert (
                validate_cards(
                    [
                        self._fristen(
                            deadlines=[
                                {"label": "Beschwerdefrist", "period": "binnen vier Wochen", "starts_from": bad},
                                {"label": "Anzeige", "period": "unverzüglich", "starts_from": "ab Fertigstellung"},
                            ]
                        )
                    ]
                )
                == []
            )

    def test_the_wordings_a_bauordnung_actually_uses_survive(self):
        # The guard must not eat the legitimate half: numbers, paragraph marks
        # and ordinals all appear in real Fristen.
        good = [
            {"label": "Beschwerdefrist", "period": "binnen 4 Wochen", "starts_from": "ab Zustellung (§ 7 Abs. 4)"},
            {"label": "Geltungsdauer", "period": "binnen vier Jahren", "starts_from": "ab Rechtskraft"},
        ]
        [card] = validate_cards([self._fristen(deadlines=good)])
        assert card["deadlines"][0]["period"] == "binnen 4 Wochen"

    def test_the_date_pattern_is_linear_against_a_pumped_input(self):
        # A recent CodeQL alert and three ReDoS fixes came out of this area, so
        # every new pattern is pumped rather than eyeballed. Both alternatives
        # are fixed-width with no nested quantifier, so the worst case is one
        # pass; anything super-linear would blow far past this budget.
        import time

        from aiq_agent.cards.models import _CALENDAR_DATE

        for pump in ("1." * 100_000, "2026-" * 100_000, "0" * 200_000):
            started = time.perf_counter()
            _CALENDAR_DATE.search(pump)
            assert time.perf_counter() - started < 1.0

    def test_one_frist_is_a_callout_and_nine_is_a_calendar(self):
        one = self._fristen(
            deadlines=[
                {"label": "Beschwerdefrist", "period": "binnen vier Wochen", "starts_from": "ab Zustellung"},
            ]
        )
        nine = self._fristen(
            deadlines=[
                {"label": f"Frist {i}", "period": "binnen vier Wochen", "starts_from": "ab Zustellung"}
                for i in range(9)
            ]
        )
        assert validate_cards([one, nine]) == []

    def test_the_worked_example_round_trips_without_a_single_date(self):
        from aiq_agent.cards.catalog import CARD_EXAMPLES
        from aiq_agent.cards.models import _CALENDAR_DATE

        card = grid_card_adapter.validate_python(CARD_EXAMPLES["deadline_timeline"])
        assert card.type == "deadline_timeline"
        assert all(not _CALENDAR_DATE.search(d.period + d.starts_from) for d in card.deadlines)
        # The example is copied for its shape, so every Frist has to model the
        # habit: the trigger event named, in words.
        assert all(d.starts_from.strip() for d in card.deadlines)


class TestAChangeCostsSomethingAndSaysWhere:
    """`change_impact` — one fact moves, and the requirements that follow."""

    @staticmethod
    def _impact(**overrides):
        raw = {
            "type": "change_impact",
            "title": "Fluchtniveau über 11 m – was sich ändert",
            "factor": "Fluchtniveau",
            "from_value": "7 bis 11 m",
            "to_value": "über 11 m",
            "consequences": [
                {
                    "aspect": "Feuerwiderstand tragender Bauteile",
                    "before": "R 60",
                    "after": "R 90",
                    "direction": "tightens",
                    "reference": {"document": "OIB-Richtlinie 2", "section": "Tabelle 1"},
                }
            ],
        }
        raw.update(overrides)
        return raw

    def test_validates_and_routes(self):
        from aiq_agent.cards.models import ChangeImpactCard

        card = grid_card_adapter.validate_python(self._impact())
        assert isinstance(card, ChangeImpactCard)
        assert card.consequences[0].direction == "tightens"

    def test_a_consequence_without_a_fundstelle_is_rejected(self):
        # This card is read to PLAN against — a Ziviltechniker decides whether
        # to keep the Fluchtniveau under 11 m by it. A consequence nobody can
        # look up is a consequence nobody can act on, so it is omitted from the
        # card rather than listed bare.
        consequences = [{"aspect": "Aufzug", "after": "Aufzug erforderlich", "direction": "tightens"}]
        assert validate_cards([self._impact(consequences=consequences)]) == []

    def test_an_unknown_starting_point_stays_unknown(self):
        # `from_value` is a claim about where the project stands TODAY, and the
        # question usually only supplies the destination. Absent survives as
        # absent; the card says so rather than printing a plausible value.
        raw = self._impact()
        del raw["from_value"]
        [card] = validate_cards([raw])
        assert "from_value" not in card

    def test_a_row_cannot_say_unchanged_while_changing(self):
        consequences = [
            {
                "aspect": "Feuerwiderstand",
                "before": "R 60",
                "after": "R 90",
                "direction": "unchanged",
                "reference": {"document": "OIB-Richtlinie 2", "section": "Tabelle 1"},
            }
        ]
        assert validate_cards([self._impact(consequences=consequences)]) == []

    def test_a_row_that_does_not_move_cannot_claim_it_tightens(self):
        consequences = [
            {
                "aspect": "Schallschutz",
                "before": "DnT,w mindestens 55 dB",
                "after": "DnT,w mindestens 55 dB",
                "direction": "tightens",
                "reference": {"document": "OIB-Richtlinie 5", "section": "Tabelle 1"},
            }
        ]
        assert validate_cards([self._impact(consequences=consequences)]) == []

    def test_the_card_carries_no_tally_for_a_renderer_to_contradict(self):
        from aiq_agent.cards.models import ChangeImpactCard

        fields = set(ChangeImpactCard.model_fields)
        assert not fields & {"tightened", "relaxed", "count", "summary", "severity"}

    def test_the_worked_example_round_trips_and_teaches_the_hard_cases(self):
        from aiq_agent.cards.catalog import CARD_EXAMPLES

        card = grid_card_adapter.validate_python(CARD_EXAMPLES["change_impact"])
        assert card.type == "change_impact"
        # Every consequence cites, one row does NOT move, and one row has no
        # `before` — the three habits the example exists to transfer.
        assert all(c.reference for c in card.consequences)
        assert any(c.direction == "unchanged" for c in card.consequences)
        assert any(c.before is None for c in card.consequences)


class TestTheThreeNewCardsAreInTheDoctrineAndNotInTheCraft:
    def test_each_has_a_trigger_line(self):
        from aiq_agent.cards.register import _CARD_DOCTRINE

        assert "-> document_checklist" in _CARD_DOCTRINE
        assert "-> deadline_timeline" in _CARD_DOCTRINE
        assert "-> change_impact" in _CARD_DOCTRINE

    def test_render_card_details_spells_out_the_nested_shapes(self):
        from aiq_agent.cards.catalog import render_card_details

        detail = render_card_details(["document_checklist", "deadline_timeline", "change_impact"])
        for block in ("RequiredDocument = {", "Deadline = {", "ChangeConsequence = {"):
            assert block in detail
        # The worked examples ride along so the model copies the nesting exactly.
        assert "Einreichunterlagen" in detail


class TestTheCitationSaysWhichAuthorityAndWhichAusgabe:
    """`legal_basis` carries its Baurecht tier and its Ausgabe on the wire.

    Both are provenance, not decoration. The tier decides which accent the
    product's proof-of-work card paints, and it has to be a LANE key so the one
    helper that decides OIB-vs-RIS (`accentForLane`) can read it — the card and
    the "Belegt durch" chips must not be able to disagree about one document.
    The Ausgabe is what separates a citation an architect can look up from one
    they cannot.
    """

    def test_a_citation_carries_its_lane_and_its_edition(self):
        card = grid_card_adapter.validate_python(
            {
                "type": "legal_basis",
                "law": "OIB-Richtlinie 2",
                "lane": "baurecht_oib",
                "edition": "Ausgabe Mai 2023",
            }
        )
        assert card.lane == "baurecht_oib"
        assert card.edition == "Ausgabe Mai 2023"

    def test_both_are_optional_and_default_to_unstated(self):
        # A card that names neither is still the proof; requiring either would
        # drop the whole citation over a display field the model may not know.
        card = grid_card_adapter.validate_python({"type": "legal_basis", "law": "Wiener Bauordnung"})
        assert card.lane is None
        assert card.edition is None

    def test_the_lane_vocabulary_is_the_one_accent_for_lane_reads(self):
        # Not 'oib' | 'law' (that is the accent it RESOLVES TO): the frontend
        # helper matches on the `baurecht_oib` lane family, so the wire has to
        # speak lanes.
        lane_field = LegalBasisCard.model_fields["lane"]
        assert typing.get_args(typing.get_args(lane_field.annotation)[0]) == ("baurecht_oib", "baurecht_ris")

    def test_a_finer_oib_lane_folds_onto_the_oib_tier(self):
        card = grid_card_adapter.validate_python(
            {"type": "legal_basis", "law": "OIB-Leitfaden", "lane": "baurecht_oib_leitfaden"}
        )
        assert card.lane == "baurecht_oib"

    def test_any_other_ris_rank_folds_onto_the_ris_tier(self):
        for lane in ("baurecht_land", "baurecht_bund", "baurecht_verordnung", "baurecht_ris"):
            card = grid_card_adapter.validate_python({"type": "legal_basis", "law": "BO", "lane": lane})
            assert card.lane == "baurecht_ris", lane

    def test_an_unclassified_document_claims_no_tier(self):
        # `baurecht_basis` is the DEFAULT lane of a document nobody classified.
        # Letting the `baurecht` prefix promote it to RIS would have an
        # unclassified upload claim to be an Austrian legal source.
        card = grid_card_adapter.validate_python(
            {"type": "legal_basis", "law": "Bescheid MA 37", "lane": "baurecht_basis"}
        )
        assert card.lane is None

    def test_a_lane_outside_the_baurecht_family_claims_no_tier(self):
        for lane in ("norm_extern", "behoerde", "projekt", "buero", "web", "", "nonsense"):
            card = grid_card_adapter.validate_python({"type": "legal_basis", "law": "ÖNORM B 1600", "lane": lane})
            assert card.lane is None, lane

    def test_an_unknown_lane_never_costs_the_card(self):
        # The renderer degrades to the stratum colour; Pydantic rejecting the
        # card would drop the proof instead of the field.
        assert validate_cards([{"type": "legal_basis", "law": "X", "lane": "made_up"}]) == [
            {"type": "legal_basis", "law": "X"}
        ]

    def test_the_worked_example_shows_the_model_both_fields(self):
        # Top-level card fields are rendered to the model WITHOUT their
        # descriptions (`_card_shape(..., with_desc=False)`), so the example is
        # the only place it learns what to put in a controlled-vocabulary field.
        from aiq_agent.cards.catalog import CARD_EXAMPLES
        from aiq_agent.cards.catalog import render_card_details

        assert CARD_EXAMPLES["legal_basis"]["lane"] == "baurecht_oib"
        assert CARD_EXAMPLES["legal_basis"]["edition"] == "Ausgabe Mai 2023"
        detail = render_card_details(["legal_basis"])
        assert '"baurecht_oib" | "baurecht_ris"' in detail
        assert "Ausgabe Mai 2023" in detail


class TestCardTextIsPlainText:
    """No card renders markup, so no card field may carry any.

    The defect these pin shipped: a production `legal_basis` card put
    „[OIB-Richtlinie ansehen](https://www.oib.or.at/de/oib-richtlinien)“ on
    screen as literal brackets, beside the card's own working link to that same
    page. The contract was never written down anywhere, so nothing enforced it.

    The fix is on the way IN, never in the renderer. A card is what gets
    screenshotted into an Einreichung; a renderer that parsed markdown in a field
    nobody declared as markdown would let the model put an arbitrary link into a
    legal citation.
    """

    def test_the_shipped_defect_reaches_the_card_as_text(self):
        card = grid_card_adapter.validate_python(
            {
                "type": "legal_basis",
                "law": "OIB-Richtlinie 2",
                "summary": "Details: [OIB-Richtlinie ansehen](https://www.oib.or.at/de/oib-richtlinien)",
            }
        )
        assert card.summary == "Details: OIB-Richtlinie ansehen (https://www.oib.or.at/de/oib-richtlinien)"

    def test_the_url_survives_as_text_rather_than_being_dropped(self):
        # Silently deleting half of what a citation asserted is the one thing a
        # sanitiser on this surface must not do. The brackets go; the target
        # stays, as text — nothing downstream turns a bare URL in a card field
        # into an anchor, so the card gains no link it did not already build.
        card = LegalBasisCard(type="legal_basis", law="X", original_text="siehe [§ 3](https://ris.bka.gv.at/x)")
        assert "https://ris.bka.gv.at/x" in card.original_text
        assert "[" not in card.original_text
        assert "](" not in card.original_text

    def test_doubled_emphasis_and_code_spans_lose_their_delimiters(self):
        card = LegalBasisCard(type="legal_basis", law="**OIB-Richtlinie 2**", summary="Mindestens `REI 90`.")
        assert card.law == "OIB-Richtlinie 2"
        assert card.summary == "Mindestens REI 90."

    def test_single_character_emphasis_is_left_alone(self):
        # `original_text` is documented as a LITERAL excerpt. A lone `*` is a
        # footnote marker in an OIB table and `_` is ordinary punctuation in a
        # file reference; mangling a verbatim legal quotation is a worse defect
        # than an asterisk, so the line is drawn at delimiters that have no
        # second reading.
        excerpt = "Die Anforderung *) gilt sinngemäß für Anlage_1."
        assert LegalBasisCard(type="legal_basis", law="X", original_text=excerpt).original_text == excerpt

    def test_it_is_the_class_and_not_just_legal_basis(self):
        # Same markup, a different card and a nested building block: the guard
        # is on the shared base, so it is not a per-card patch.
        card = grid_card_adapter.validate_python(
            {
                "type": "key_takeaways",
                "title": "**Kernaussagen**",
                "items": [
                    {"text": "Siehe [RIS](https://ris.bka.gv.at)", "detail": "`§ 3` gilt."},
                    {"text": "Gebäudeklasse 4"},
                ],
            }
        )
        assert card.title == "Kernaussagen"
        assert card.items[0].text == "Siehe RIS (https://ris.bka.gv.at)"
        assert card.items[0].detail == "§ 3 gilt."

    def test_table_cells_are_reached_through_the_nested_list(self):
        # `TypedTableCard.rows` is list[list[str]] — a cell is as much on-screen
        # text as a title is, and a one-level walk would miss every one of them.
        card = grid_card_adapter.validate_python(
            {
                "type": "typed_table",
                "title": "Mindestmaße",
                "columns": [{"label": "Bauteil", "type": "text"}, {"label": "Wert", "type": "mass"}],
                "rows": [["**Tragende Wand**", "REI 90"]],
            }
        )
        assert card.rows == [["Tragende Wand", "REI 90"]]

    def test_every_card_type_inherits_the_guarantee(self):
        # The point of putting it on a base class: a card type added next sprint
        # is covered by BEING a card, not by someone remembering to annotate its
        # fields. 177 free-text fields across 71 models is 177 chances to forget.
        for card_cls in GridCard.__args__:
            assert issubclass(card_cls, CardModel), card_cls.__name__

    def test_flattening_is_idempotent_and_leaves_plain_text_untouched(self):
        plain = "OIB-Richtlinie 2, Ausgabe Mai 2023 — § 3 Abs. 1 (Brandschutz)."
        assert flatten_card_markup(plain) == plain
        once = flatten_card_markup("[a](https://x) **b** `c`")
        assert flatten_card_markup(once) == once
