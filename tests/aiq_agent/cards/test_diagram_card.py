"""The `diagram` card: the one drawing whose renderer cannot check it.

Every other card that draws — the fifteen schematics — holds its invariant by
having the renderer compute the geometry, so the card cannot disagree with its
own numbers. Mermaid text IS the geometry, so that invariant is not available
here and the model's declaration is the only thing left to check. These tests
pin what that check does and, just as importantly, what it must NOT refuse: a
validator that rejects a diagram which would have drawn perfectly pushes the
answer back onto the unvalidated ```mermaid fence this card exists to replace.
"""

import pytest
from pydantic import ValidationError

from aiq_agent.cards.catalog import CARD_EXAMPLES
from aiq_agent.cards.catalog import INTERACTIVE_CARD_TYPES
from aiq_agent.cards.catalog import model_facing_card_types
from aiq_agent.cards.catalog import render_card_details
from aiq_agent.cards.catalog import render_card_index
from aiq_agent.cards.models import DiagramCard
from aiq_agent.cards.models import grid_card_adapter

FLOWCHART = "flowchart TD\n  A[Bauanzeige] --> B{Vollständig?}\n  B -->|nein| A\n  B -->|ja| C[Prüfung]"


def _card(**overrides) -> dict:
    payload = {
        "type": "diagram",
        "title": "Ablauf einer Bauanzeige",
        "diagram_type": "flowchart",
        "source": FLOWCHART,
    }
    payload.update(overrides)
    return payload


class TestTheDeclarationIsHonoured:
    @pytest.mark.parametrize(
        ("declared", "source"),
        [
            ("flowchart", FLOWCHART),
            # `graph` is the legacy flowchart header most training data still
            # carries. It draws, so refusing it would refuse a working diagram.
            ("flowchart", "graph LR\n  A[Antrag] --> B[Bescheid]"),
            ("sequence", "sequenceDiagram\n  BW->>BB: Einreichung"),
            ("state", "stateDiagram-v2\n  [*] --> Eingereicht"),
            ("state", "stateDiagram\n  [*] --> Eingereicht"),
            ("pie", 'pie title Anteile\n  "Wohnen": 60\n  "Büro": 40'),
        ],
    )
    def test_every_supported_grammar_and_its_spellings(self, declared, source):
        card = grid_card_adapter.validate_python(_card(diagram_type=declared, source=source))
        assert isinstance(card, DiagramCard)

    def test_front_matter_a_directive_and_comments_may_precede_the_declaration(self):
        """All three are valid mermaid above the header, so all three must pass.

        A validator that read line one literally would refuse a source mermaid
        draws without complaint — the one direction this check must not fail in.
        """
        source = (
            "---\ntitle: Bauanzeige\n---\n"
            '%%{init: {"theme": "base"}}%%\n'
            "%% Reihenfolge nach der Wiener Bauordnung\n"
            "flowchart TD\n  A[Antrag] --> B[Bescheid]"
        )
        assert grid_card_adapter.validate_python(_card(source=source))

    def test_a_source_that_declares_nothing_is_refused(self):
        # The most common way a model-written diagram fails: mermaid has no
        # grammar to read the rest with, so the whole block collapses to a grey
        # code box in the middle of the answer.
        with pytest.raises(ValidationError, match="declares no diagram type"):
            grid_card_adapter.validate_python(_card(source="A[Antrag] --> B[Bescheid]"))

    def test_a_declaration_that_disagrees_with_the_field_is_refused(self):
        with pytest.raises(ValidationError, match="but `source` declares 'flowchart'"):
            grid_card_adapter.validate_python(_card(diagram_type="sequence"))

    @pytest.mark.parametrize("keyword", ["journey", "gantt", "erDiagram", "mindmap"])
    def test_a_grammar_this_pipeline_cannot_carry_is_refused_by_name(self, keyword):
        """Named, because the fix differs from the fix for a missing header.

        A `journey` is refused in the reader's browser too — mermaid emits a
        foreignObject element for it whatever `htmlLabels` says and the SVG
        allow-list refuses that — so it would degrade to its own source text
        inside the answer. Refusing it here turns an invisible degradation into
        a message the model can act on.
        """
        with pytest.raises(ValidationError, match=f"is a '{keyword.lower()}' diagram"):
            grid_card_adapter.validate_python(_card(source=f"{keyword}\n  title Etwas"))


class TestTheSourceSurvivesTheCardPipeline:
    def test_mermaid_node_shapes_are_not_mangled_by_the_plain_text_flattener(self):
        """`CardModel` strips markdown delimiters from every string on every card.

        Mermaid's node shapes are bracket-and-paren soup, so this is worth
        pinning rather than assuming: a link is only recognised as `](`
        ADJACENT, which no mermaid node syntax produces — `A[(Datenbank)]` and
        `A[Text] --> B(Rund)` both keep their punctuation.
        """
        source = "flowchart TD\n  A[(Register)] --> B([Prüfung])\n  B --> C[Bescheid] --> D(Ende)"
        card = grid_card_adapter.validate_python(_card(source=source))
        assert card.source == source

    def test_a_source_longer_than_a_readable_diagram_is_refused(self):
        # 4,000 characters is already ~100 lines of mermaid. The pipeline's own
        # 32 KiB cap is a refusal budget for arbitrary bytes; this one is about
        # what a reader can take in.
        with pytest.raises(ValidationError):
            grid_card_adapter.validate_python(_card(source="flowchart TD\n" + "  A --> B\n" * 500))


class TestTheCatalogTeachesTheBoundary:
    def test_the_index_line_carries_the_boundary_not_just_the_trigger(self):
        """L1 is one line per card and it is all the model has before L2.

        A line that only said "draws a diagram" would collect every measured
        answer in the product, which is the one failure this card must not have.
        """
        line = next(line for line in render_card_index().splitlines() if line.strip().startswith('- "diagram"'))
        assert "never a measurement" in line

    def test_the_boundary_rides_with_the_shape_and_only_with_it(self):
        detail = render_card_details(["diagram"])
        assert "What a `diagram` may draw" in detail
        assert "belongs to the schematic cards" in detail
        assert "What a `diagram` may draw" not in render_card_details(["callout"])

    def test_the_worked_example_is_a_shape_process_map_cannot_hold(self):
        # If the example were an ordered Verfahren it would teach the model to
        # reach past `process_map`, which is the collision this card is bounded
        # against.
        example = CARD_EXAMPLES["diagram"]
        assert example["diagram_type"] == "sequence"
        assert grid_card_adapter.validate_python(example)

    def test_it_is_advertised_to_the_model(self):
        assert "diagram" in model_facing_card_types()

    def test_it_is_presentational_and_this_half_must_match_the_frontend(self):
        """The card renders a drawing and commits nothing (ADR-0030).

        It arrived here classified interactive, for an „Im Projekt ablegen"
        button on the card that v1 does not ship. A decision on a card is a
        `CardDecision` plus a timestamp and nothing else, so storing `filed`
        would record that filing happened and lose WHERE it went — the id of the
        filed document is the answer's one pointer into the Files pane. Filing
        is idempotent (answer id + source hash), so leaving the decision
        unpersisted leaves a reader who reloads with a live button that gives
        the link back; the other way is a permanent loss. Filing therefore stays
        on the mermaid FENCE, which already offers it wherever a surface
        supplies a target.

        This must agree with `CARD_INTERACTIVITY` in `card-decision.ts` —
        `test_interactive_card_parity.py` is what holds the two together, and
        this asserts the backend's own half so the reason survives with it.
        """
        assert "diagram" not in INTERACTIVE_CARD_TYPES


class TestTheCardAcceptsWhatModelsActuallyWrite:
    """The two refusal traps that made every field diagram invisible.

    Both are unique to this card, which is why every other card rendered while
    this one never reached the client: no other payload carries a large
    multi-line string, and no other field invites a markdown fence around it.
    """

    FLOW = "flowchart TD\n A[Landesrecht] --> B{OIB 2 verbindlich?}\n B -->|Ja| C[OIB-Richtlinie 2]"

    def test_a_fence_wrapped_source_is_unwrapped_and_validated(self):
        # Everything this product teaches the model says "mermaid lives in a
        # fence", so wrapping the source is the natural fill — decoration,
        # not information.
        card = DiagramCard.model_validate(
            {
                "type": "diagram",
                "title": "OIB 2",
                "diagram_type": "flowchart",
                "source": "```mermaid\n" + self.FLOW + "\n```",
            }
        )
        assert card.source.startswith("flowchart TD")
        assert "```" not in card.source

    def test_a_bare_fence_and_a_truncated_one_unwrap_too(self):
        for source in ("```\n" + self.FLOW + "\n```", "```mermaid\n" + self.FLOW):
            card = DiagramCard.model_validate(
                {"type": "diagram", "title": "OIB 2", "diagram_type": "flowchart", "source": source}
            )
            assert card.source.startswith("flowchart TD")

    def test_unwrapping_does_not_launder_a_real_defect(self):
        # A journey inside a fence is still a journey: the wrapper comes off
        # and the grammar refusal still fires.
        with pytest.raises(ValidationError, match="journey"):
            DiagramCard.model_validate(
                {
                    "type": "diagram",
                    "title": "X",
                    "diagram_type": "flowchart",
                    "source": "```mermaid\njourney\n  title Nutzerreise\n```",
                }
            )

    def test_a_raw_newline_in_the_json_string_still_registers_the_card(self):
        # The wire form a model actually produces for a multi-line source. A
        # strict parse called this "not valid JSON" and rejected every diagram
        # while every short-fielded card sailed through. Tested through the
        # REAL registration seam (the DSML salvage mirrors emit_card's parse),
        # so a revert of strict=False fails this, not just a parsing habit.
        from aiq_agent.agents.shallow_researcher.dsml import _salvage_card
        from aiq_agent.cards.registry import CardRegistry
        from aiq_agent.cards.registry import reset_card_registry
        from aiq_agent.cards.registry import set_card_registry

        raw = '{"type":"diagram","title":"OIB 2","diagram_type":"flowchart","source":"' + self.FLOW + '"}'
        assert "\n" in raw
        registry = CardRegistry()
        token = set_card_registry(registry)
        try:
            _salvage_card(raw)
        finally:
            reset_card_registry(token)
        cards = registry.snapshot()
        assert len(cards) == 1
        assert cards[0]["type"] == "diagram"
