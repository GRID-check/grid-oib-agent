"""The Fundstelle margin on ``legal_basis`` — the width the model cannot see.

``article`` and ``section`` are set in a 72px margin at 11px mono, the way a
statute prints its § beside the text. A shipped card put „Punkte 8 bis 10 der
OIB-Richtlinie 2" and „Anwendungsbereiche der ergänzenden Richtlinien" there and
rendered a nine-line ragged pillar taller than the card beside it — on the
product's proof-of-work card.

Top-level card fields are rendered to the model WITHOUT their descriptions
(``_card_shape`` passes ``with_desc=False``), so the field descriptions in
``models.py`` do not reach it and the worked example alone did not hold. These
pin the note that does, and the renderer's own degradation is pinned on the
frontend by ``LegalBasisCard.spec.tsx``.
"""

from aiq_agent.cards.catalog import CARD_EXAMPLES
from aiq_agent.cards.catalog import render_card_catalog
from aiq_agent.cards.catalog import render_card_details


class TestTheCatalogTeachesTheMargin:
    def test_the_margin_rule_rides_with_the_shape_and_only_with_it(self):
        detail = render_card_details(["legal_basis"])
        assert "The Fundstelle on a `legal_basis` card" in detail
        assert "identifier and never a sentence" in detail
        assert "The Fundstelle on a `legal_basis` card" not in render_card_details(["callout"])

    def test_it_names_the_two_values_that_actually_shipped(self):
        # A rule stated abstractly ("keep it short") is the rule the card already
        # had. The two strings are what the model wrote, so they are what it has
        # to recognise.
        detail = render_card_details(["legal_basis"])
        assert "Punkte 8 bis 10 der\n  OIB-Richtlinie 2" in detail
        assert "Anwendungsbereiche der\n  ergänzenden Richtlinien" in detail

    def test_the_post_hoc_surface_gets_it_too(self):
        # The batch generator fills the same two fields, from the same answer.
        assert "The Fundstelle on a `legal_basis` card" in render_card_catalog()

    def test_the_worked_example_stays_inside_the_budget(self):
        # The example is the other half of the guidance; a prose Fundstelle here
        # would teach exactly what the note forbids.
        example = CARD_EXAMPLES["legal_basis"]
        assert len(example["article"]) <= 20
        assert len(example["section"]) <= 20
