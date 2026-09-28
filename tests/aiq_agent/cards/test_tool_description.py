"""Tests for the ``emit_card`` tool description and validation hints.

These guard the two things that made cards fail to emit in practice: the tool
description must expose the *nested* shapes (not just top-level field names), and
the worked examples must stay valid against the live card models.
"""

import pytest

from aiq_agent.cards.catalog import _CARD_HONESTY
from aiq_agent.cards.catalog import _CARD_RESTRAINT
from aiq_agent.cards.catalog import _CARD_TRIGGER_HEAD
from aiq_agent.cards.catalog import _CARD_TRIGGERS
from aiq_agent.cards.catalog import _MODEL_PICKER_NOTE
from aiq_agent.cards.catalog import _MODEL_PICKER_ROW
from aiq_agent.cards.catalog import CHAT_ONLY_CARD_TYPES
from aiq_agent.cards.catalog import ENVELOPE_CARD_TYPES
from aiq_agent.cards.catalog import INTERACTIVE_CARD_TYPES
from aiq_agent.cards.catalog import SYSTEM_CARD_TYPES
from aiq_agent.cards.catalog import _interactive_note
from aiq_agent.cards.catalog import model_facing_card_types
from aiq_agent.cards.catalog import render_card_catalog
from aiq_agent.cards.catalog import render_card_details
from aiq_agent.cards.catalog import render_card_doctrine
from aiq_agent.cards.catalog import render_card_index
from aiq_agent.cards.models import GridCard
from aiq_agent.cards.models import grid_card_adapter
from aiq_agent.cards.register import _CARD_EXAMPLES
from aiq_agent.cards.register import _build_tool_description
from aiq_agent.cards.register import _shape_hint_for

_CARD_TYPES = [getattr(c.model_fields["type"].annotation, "__args__", ("?",))[0] for c in GridCard.__args__]


# Card types deliberately shipped WITHOUT a worked example — flat/simple shapes
# the model reliably produces from the one-line shape spec alone. Adding a new
# card type forces a choice: give it an example or list it here (see coverage
# test below), so a hard-to-nest type can't slip in with no guidance.
_EXAMPLE_EXEMPT = {
    # The three model-backed cards carry an identifier and nothing else: the
    # frontend reads every number from the model, so there is no nesting for an
    # example to disambiguate. `ifc_viewer` IS exampled, because its highlight
    # groups are nested.
    "ifc_schedule",
    "ifc_element",
    "ifc_diff",
    "summary",
    "stair_diagram",
    "dimension_diagram",
    "setback_plan",
    "egress_diagram",
    "guardrail_check",
    "density_check",
    "fire_access_plan",
    "acoustic_check",
    "energy_performance",
    "elevator_requirement",
    # System-emitted (by the remember tool); never advertised to the model, so it
    # ships without a worked example on purpose.
    "memory_proposal",
    # System-emitted (by the surface_documents tool) from a real corpus search;
    # never advertised to the model, so it ships without a worked example.
    "document_grid",
    # System-emitted (by the working directory's write_file/edit_file) and built
    # in Python from the file that was just written; the model never authors one,
    # so an example would teach a shape it must not produce.
    "document_draft",
    # System-emitted (by the four write-side workspace tools) and built in
    # Python from names the tool RESOLVED against the turn's inventory. An
    # example would teach a shape the model must not produce — and this is the
    # card where authoring one would mean naming a file it never looked up.
    "file_operation_proposal",
    # System-emitted (by `create_task`) and built in Python from the id and the
    # title the BFF returned. An example would teach the model to author proof
    # that a task row exists — which is the one claim this card was added to
    # make unfakeable.
    "task_created",
}


class TestWorkedExamples:
    @pytest.mark.parametrize("card_type", list(_CARD_EXAMPLES))
    def test_example_validates(self, card_type):
        # A drifted example would teach the model the wrong shape — fail loudly.
        grid_card_adapter.validate_python(_CARD_EXAMPLES[card_type])

    def test_every_card_type_has_example_or_is_exempt(self):
        # A new card type must not silently ship with neither an example nor a
        # deliberate exemption.
        documented = set(_CARD_EXAMPLES) | _EXAMPLE_EXEMPT
        missing = [t for t in _CARD_TYPES if t not in documented]
        assert not missing, f"New card type(s) need a worked example or an _EXAMPLE_EXEMPT entry: {missing}"


class TestModelFacingCardTypes:
    def test_is_the_union_minus_system_and_envelope_cards(self):
        # The one answer to "may this card be asked for by name?" — used by the
        # tool description here and by the skills substrate's `grid-cards`
        # validation, so the two can never disagree about a new card type. The
        # envelope types are out too: on the answering surface they travel in
        # the answer_meta trailer, never through a tool call.
        assert model_facing_card_types() == set(_CARD_TYPES) - SYSTEM_CARD_TYPES - ENVELOPE_CARD_TYPES
        assert model_facing_card_types().isdisjoint(SYSTEM_CARD_TYPES | ENVELOPE_CARD_TYPES)


class TestToolDescription:
    def test_returns_string(self):
        assert isinstance(_build_tool_description(), str)

    def test_several_cards_are_one_call(self):
        # Two cards used to arrive as two emit_card rounds, each a full pass over
        # the turn's context. Told they were one call each in one round, the
        # fleet still spent a round per card; the array is the form that cannot
        # be issued serially. Stated here and nowhere else: the doctrine owns
        # the ceiling, this owns how the cards are issued.
        desc = _build_tool_description()
        assert "Several cards are one call: pass a JSON array of card objects." in desc
        assert "one call each" not in desc
        assert "several times" not in desc
        assert "same round" not in render_card_doctrine()

    def test_lists_every_card_type(self):
        desc = _build_tool_description()
        for card_type in _CARD_TYPES:
            if card_type in SYSTEM_CARD_TYPES | ENVELOPE_CARD_TYPES | CHAT_ONLY_CARD_TYPES:
                continue
            assert f'"{card_type}"' in desc

    def test_system_cards_are_not_advertised(self):
        # System cards (memory_proposal) must not appear in the model-facing tool
        # description — the model must never be able to fabricate them.
        desc = _build_tool_description()
        for card_type in SYSTEM_CARD_TYPES:
            assert f'"{card_type}"' not in desc
        assert "memory_proposal" not in desc

    def test_expands_nested_building_blocks_on_demand(self):
        # Nested object shapes must be spelled out, not hidden behind a bare
        # field name like `glass_area`. They moved OFF the always-on tool
        # description (~5,200 tokens every turn, emitted card or not) and onto
        # `describe_card`, which is asked for the one type that is needed.
        detail = render_card_details(["daylight_incidence"])
        assert "DimensionCheck = {" in detail
        assert "NormReference = {" in detail
        assert "needs_input" in detail  # enum options surfaced

    def test_includes_worked_examples_on_demand(self):
        detail = render_card_details(["daylight_incidence"])
        assert "Worked examples" in detail
        assert "daylight_incidence" in detail

    def test_the_index_names_every_card_without_its_shape(self):
        # L1 is one line per type: enough for the model to know a card EXISTS
        # and pick it, not enough to fill it in. That split is what keeps the
        # marginal cost of a new card type at ~23 tokens instead of ~193.
        desc = _build_tool_description()
        assert '"daylight_incidence"' in desc
        assert "DimensionCheck = {" not in desc
        assert "Worked examples" not in desc

    def test_says_the_fields_are_plain_text_wherever_the_shapes_are_shown(self):
        # A shipped `legal_basis` card wrote a markdown link into a text field
        # and the card printed the brackets. `CardModel` strips them, so this
        # rule is not what makes the card correct — it is what keeps the field
        # holding what the model meant instead of the wreckage of a link.
        #
        # It rides with the SHAPES, not with the doctrine, for the same reason
        # the measured-numbers rule does: the doctrine is paid on every turn
        # whether or not a card is emitted, and a model that has just been handed
        # the shapes is the one about to write these strings.
        for shown in (render_card_details(["legal_basis"]), render_card_catalog()):
            assert "Every text field is PLAIN TEXT" in shown
            assert "no [text](url) links" in shown
        assert "PLAIN TEXT" not in render_card_doctrine()
        assert "PLAIN TEXT" not in render_card_index()

    def test_flags_cards_that_ask_the_user_to_confirm(self):
        # A consent card costs the user a DECISION, not just screen space
        # (ADR-0030). Without saying so, the model emits them speculatively and
        # the answer becomes a pile of consent prompts.
        desc = _build_tool_description()
        assert "Cards that ask the user to CONFIRM something" in desc
        for card_type in INTERACTIVE_CARD_TYPES - SYSTEM_CARD_TYPES:
            assert f'"{card_type}"' in desc
        assert "At most one per turn" in desc

    def test_a_diagram_is_not_advertised_as_a_consent_prompt(self):
        """A drawing puts no question to anybody, and must not be framed as one.

        Telling the model that a `diagram` "asks the user to authorize a real,
        persisted change" and must never be emitted speculatively would suppress
        the card on exactly the answers it exists for: the cost of a drawing is
        screen space, not consent.

        This asserted the same thing about a `CONSENT_CARD_TYPES` that no longer
        exists. The card ships PRESENTATIONAL — it renders a Verfahren and
        commits nothing, and filing one into the project stays on the mermaid
        fence — so "must the frontend persist an answer?" and "does emitting it
        ask something of the reader?" name one set again, and the guard is that
        `diagram` is in neither.
        """
        assert "diagram" not in INTERACTIVE_CARD_TYPES
        consent_block = _build_tool_description().split("Cards that ask the user to CONFIRM something")[1]
        assert '"diagram"' not in consent_block.split("\n\n")[0]


class TestTheDoctrineStaysCalibrated:
    """The doctrine must invite a card without demanding one, and it is MEASURED.

    Two field observations bound this from opposite sides, and both are real.

    Under-emission, specific: asked „Wie läuft das Baubewilligungsverfahren in
    Wien ab?" — almost the words of the ``process_map`` trigger line — the model
    answered in numbered prose, then two turns later named the card and built a
    good one on the first attempt. ``follow_ups`` has never been seen at all,
    with its shape already inlined in ``grid-cards``, so a `describe_card`
    round-trip was never the cost in the way.

    Over-emission, general: the product owner's reading of the fleet is that
    cards "do get put out quite good". So the general rate was not the problem,
    and pushing on it buys only the failure the charter's anti-goal D.8 names —
    a card that restates the prose beside it, which "cannot be made beautiful,
    only bigger". That charter names ``_CARD_RESTRAINT`` as where the rule is
    enforced, so this doctrine is load-bearing for it.

    The first fix overcorrected and this suite is the record of it. The original
    default was scoped to one card class ("an answer that turns on a DIMENSION
    gets its card by default"), measuring 2.4 : 1 restraint to invitation; the
    rewrite made a match an obligation and swung to 0.9 : 1, i.e. net
    invitation. The landing point is a match as a REASON, at ~1.4 : 1.

    So the assertions below pin a BAND, not a direction. Either edge is a
    regression and neither is visible in a diff.
    """

    #: Span-level polarity of the always-on doctrine PROSE, cl100k tokens.
    #: Deliberately excludes the trigger rows, their craft blocks and the card
    #: index: those are vocabulary, and counting them would swamp the prose that
    #: sets the disposition. The craft that came out of the prompt's `<cards>`
    #: section is craft — how a card that has already been chosen is filled well
    #: — so it moves neither side of this ratio, which is why the band held
    #: through that move untouched. Measured at 1.42 : 1 when written (invitation 167,
    #: restraint 237), and 1.48 : 1 after the naming clause and the
    #: form-versus-facts discriminator went in together (invitation 198,
    #: restraint 293) — both edges of the band untouched, because each half of
    #: that pass pushes the opposite way.
    #:
    #: Retiring the ``follow_ups`` card took spans off BOTH sides at once —
    #: ``_FOLLOW_UPS_RULE``'s "closes a subject-matter answer by default" was
    #: invitation, its "Two narrow exceptions" was restraint, and the volume
    #: rule's exemption went with them — landing at 1.44 : 1 (invitation 163,
    #: restraint 234). That the band held through a removal this size is the
    #: point of pinning a ratio rather than a token count.
    MIN_RESTRAINT_RATIO = 1.15
    MAX_RESTRAINT_RATIO = 1.75

    @staticmethod
    def _polarity() -> tuple[int, int]:
        """(invitation, restraint) tokens over the doctrine's prose blocks."""
        import tiktoken

        encoding = tiktoken.get_encoding("cl100k_base")
        count = lambda text: len(encoding.encode(text))  # noqa: E731

        head = _CARD_TRIGGER_HEAD
        picker_invitation = _MODEL_PICKER_NOTE.split("It renders")[0]

        invitation = count(head) + count(picker_invitation)
        restraint = count(_CARD_RESTRAINT) + count(_interactive_note())
        return invitation, restraint

    def test_the_doctrine_sits_inside_its_calibration_band(self):
        pytest.importorskip("tiktoken")
        invitation, restraint = self._polarity()
        ratio = restraint / invitation

        assert self.MIN_RESTRAINT_RATIO <= ratio <= self.MAX_RESTRAINT_RATIO, (
            f"The always-on card doctrine reads {ratio:.2f} : 1 restraint to invitation "
            f"(invitation {invitation} tokens, restraint {restraint}), outside the "
            f"{self.MIN_RESTRAINT_RATIO}–{self.MAX_RESTRAINT_RATIO} band. Below the band the "
            "doctrine reads as an obligation and buys cards that restate the prose beside them "
            "(charter anti-goal D.8); above it, it reads as a disclaimer and specific cards stop "
            "being emitted at all. Moving this band is a decision about the fleet's emission rate "
            "and needs a field observation behind it, not a rewording."
        )

    def test_a_trigger_match_is_a_reason_and_not_an_obligation(self):
        doctrine = render_card_doctrine()
        # A reason to reach for the card...
        assert "is a reason to" in doctrine
        assert "rather than mere permission" in doctrine
        # ...and the restatement test sits INSIDE the invitation, so the
        # invitation is self-limiting rather than leaning on WHEN NOT TO alone.
        assert "carries more than the sentence beside it" in doctrine
        # Not an obligation: no clause making non-emission the exception, and no
        # naming of prose-instead as a failure. Both read as "always emit".
        assert "IS a card, by default" not in doctrine
        assert "Not emitting on a match is" not in doctrine
        assert "one failure mode" not in doctrine

    def test_the_naming_clause_converts_recognition_into_emission(self):
        # What commit a5488b1c took out and this puts back, minus the framing it
        # was right to remove. The deleted sentence read "if you can NAME the
        # card that fits, emit it: knowing which one fits and writing the answer
        # as prose anyway is this tool's one failure mode" — a naming clause
        # welded to an obligation, deleted whole. Every other line of the head
        # is about RECOGNISING the card; both field transcripts show recognition
        # working (asked again in plainer words, the model named the right card
        # and built it well first try) and emission not following. That step is
        # the only one the rest of the doctrine cannot reach.
        doctrine = render_card_doctrine()
        assert "Naming the card IS the decision" in doctrine
        # Restored as a consequence, not a duty: the obligation half stays out,
        # which the sibling test below re-asserts.
        assert "not a second judgement" in doctrine

    def test_the_restatement_veto_discriminates_form_from_facts(self):
        # The veto is real and stays: a card that repeats the prose beside it
        # cannot be made good, only bigger (anti-goal D.8). What it lacked was a
        # SCOPE. "Says what the prose says" reads on any answer whose prose
        # already enumerates its cases — which is both observed transcripts —
        # and cuts exactly the card that helps most. A table of three Lagen with
        # their Anforderung and Fundstelle is not three sentences said again.
        assert "about FORM, not" in _CARD_RESTRAINT
        assert "is not a restatement of three" in _CARD_RESTRAINT
        assert "Shared facts alone never cut a card" in _CARD_RESTRAINT
        # The veto itself is untouched: same words, same shape still loses.
        assert "says in the same words" in _CARD_RESTRAINT

    def test_every_craft_row_names_its_card_and_says_it_once(self):
        # The consolidation's invariant: a card type with craft has ONE craft
        # block, and it sits under the row that names it. Two blocks for one
        # card is the split coming back — the prompt's `<cards>` section grew a
        # second budget, a second restatement test and a second set of sharpened
        # triggers beside the doctrine's, and nobody could see it in a diff
        # because each copy read fine on its own.
        doctrine = render_card_doctrine()
        # The craft is wrapped to the doctrine's column when it is rendered, so
        # compare on whitespace-normalised text rather than on line breaks.
        flat = " ".join(doctrine.split())
        crafted = [(card, craft) for _, card, craft in (*_CARD_TRIGGERS, _MODEL_PICKER_ROW) if craft]
        assert crafted, "the doctrine carries no craft at all; the tool no longer owns its contract"

        for card, craft in crafted:
            # The trigger line naming that card is there...
            assert f"-> {card}" in doctrine, card
            # ...and so is the craft that fills it in.
            said = flat.count(" ".join(craft.split()))
            assert said == 1, f"{card}: craft stated {said} times"

        # The generic shapes are the ones that needed it: the same content fits
        # three of them and only one takes work off the reader.
        crafted_types = {card for card, _ in crafted}
        for card in ("condition_tree", "typed_table", "comparison_table", "calculation", "process_map"):
            assert card in crafted_types, card
        for card in ("document_checklist", "deadline_timeline", "change_impact", "norm_chain", "legal_basis"):
            assert card in crafted_types, card

    def test_the_craft_comes_off_when_the_surface_cannot_act_on_it(self):
        # Post-hoc generation renders the rows without them: "mark `current_step`
        # only where the conversation established it" is an instruction about an
        # answer still being written.
        rows_only = render_card_doctrine(include_craft=False)
        assert "-> process_map" in rows_only
        assert "Stations must CARRY something" not in rows_only
        assert "Stations must CARRY something" in render_card_doctrine()

    def test_the_default_is_not_scoped_to_one_class_of_card(self):
        # The original defect, and the one thing the rewrite must not give back:
        # a default naming only measurements left `process_map` matching its
        # trigger word for word and still coming back as prose.
        doctrine = render_card_doctrine()
        assert "An answer that turns on a dimension gets its card by default" not in doctrine
        assert "This table maps content to card" in doctrine

    def test_the_specific_cards_keep_their_own_imperative_in_the_always_on_index(self):
        # What actually carries the two observed misses, now that the head is a
        # reason rather than an obligation. These live in the L1 index, are paid
        # on every turn already, and push per CARD instead of across the table —
        # which is the difference between fixing a miss and raising the rate.
        index = render_card_index()
        assert '"process_map": Emit for' in index
        assert '"calculation": Emit for' in index
        # The rhetorical pair left the tool surface for the answer_meta trailer;
        # what the index owes the model now is the redirect, not the imperative.
        assert '"key_takeaways"' not in index
        assert '"callout"' not in index
        # Added with 0061: `typed_table` is where BOTH the doctrine's
        # "rows that are all true at once" row and `condition_tree`'s own
        # docstring redirect, and its L1 line was pure description — "A generic
        # table whose columns declare their type so cells render right" — while
        # every card around it said "Emit for". A redirect does not land if the
        # destination never asks to be emitted.
        assert '"typed_table": Emit for' in index

    def test_the_anti_fabrication_rule_stands_apart_and_outranks_the_triggers(self):
        # The one rule that must NOT be softened to get more cards. It was a
        # sentence inside the volume paragraph, where a model discounting "two
        # is plenty" as tone discounts it too; it is its own block now, and it
        # says out loud that it beats a trigger match.
        doctrine = render_card_doctrine()
        assert "Never fabricate a field, a reference or a number" in _CARD_HONESTY
        assert "outranks every trigger" in _CARD_HONESTY
        assert "needs_input" in _CARD_HONESTY
        assert "never" in _CARD_HONESTY and "estimated" in _CARD_HONESTY
        # Stated once, in its own block, not folded back into the volume rule.
        assert "fabricate" not in _CARD_RESTRAINT
        assert doctrine.count("Never fabricate a field") == 1

    def test_the_volume_rule_reads_as_a_ceiling(self):
        # The charter names this constant as where "no card that restates the
        # prose beside it" is enforced, so it may not read as an invitation to
        # spend. It briefly said "a budget and it is there to be SPENT"; a rule
        # that invites spending cannot enforce a restatement veto.
        assert "ceiling" in _CARD_RESTRAINT
        assert "there to be SPENT" not in _CARD_RESTRAINT
        assert "budget" not in _CARD_RESTRAINT
        # What the same pass added and this keeps: the two cases where none is
        # right. The `follow_ups` exemption that used to sit here went with the
        # retired card — see TestTheFollowUpsCardIsRetired.
        assert "only repeats the sentence above it" in _CARD_RESTRAINT
        assert "says in the same words" in _CARD_RESTRAINT

    def test_looking_a_shape_up_is_not_framed_as_a_cost(self):
        # Cause two, addressed for 20 tokens instead of the ~693 it costs to
        # inline `process_map`'s shape on every turn. The old wording named only
        # what a WRONG guess costs, which prices the round-trip and never prices
        # the card that does not get emitted.
        desc = _build_tool_description()
        assert "never a reason to skip a card" in desc
        assert "guessing the nesting wastes a turn" not in desc


class TestShapeHint:
    """What a failed ``emit_card`` hands back — the whole L2 entry, not a gist.

    It used to be a one-line abbreviation: shape and blocks joined with "where",
    example after a full stop, no field rules. A model that had just got a field
    wrong was handed the same information more densely, so its retry was a guess
    too, and the only way to actually learn a shape was a charged
    ``describe_card`` call the tool description had to talk it into paying in
    advance — on every turn, for every card, including the ones it would have
    got right. The retry is the one moment we know a shape is needed and know
    which type needs it, so that is where the tokens go.
    """

    @pytest.mark.parametrize("card_type", sorted(model_facing_card_types()))
    def test_the_hint_is_what_describe_card_returns(self, card_type):
        hint = _shape_hint_for(card_type)
        assert hint is not None
        assert card_type in hint
        # Byte-identical to the L2 entry, so the retry path cannot drift from
        # the tool that still serves the deep-research writer.
        assert hint == render_card_details([card_type])
        if card_type in CHAT_ONLY_CARD_TYPES:
            return  # a surface's entry is the COMPOSE rule (test_surface_card.py)
        # The four parts of an L2 entry a one-line gist did not carry.
        assert "shape:" in hint
        assert "Every text field is PLAIN TEXT" in hint

    def test_the_hint_carries_the_worked_example_where_there_is_one(self):
        hint = _shape_hint_for("daylight_incidence")
        assert "Worked examples" in hint
        assert '"type": "daylight_incidence"' in hint

    def test_hint_expands_referenced_blocks(self):
        hint = _shape_hint_for("daylight_incidence")
        assert "DimensionCheck = {" in hint
        assert "NormReference = {" in hint

    def test_unknown_type_returns_none(self):
        assert _shape_hint_for("not_a_real_card") is None

    @pytest.mark.parametrize("card_type", sorted(SYSTEM_CARD_TYPES | ENVELOPE_CARD_TYPES))
    def test_a_card_the_model_may_not_emit_is_taught_no_shape(self, card_type):
        # The retry hint is teaching material, and teaching one of these would
        # be teaching a card the very next check refuses. `_emit` names the right
        # channel instead — the answer envelope's field, or nothing at all.
        assert _shape_hint_for(card_type) is None


class TestTheDescriptionStaysAffordable:
    """A ceiling on what `emit_card` costs before the model has done anything.

    This description is prepended to every turn on the cost-optimised tier,
    whether or not the answer ends up emitting a card. It was 5,209 tokens when
    every shape and worked example was rendered inline; splitting the catalog
    into an index plus `describe_card` cut it to roughly 700, and it then crept
    back to 2,126 because each new card type added a trigger line AND a
    paragraph of craft — a drift nobody could see in a diff, because every
    individual paragraph was worth its own hundred tokens.

    The ceiling is the guard against that specific failure. It is deliberately
    slack: it does not pin today's number, it fails only when the description
    has grown by roughly a third, which is far too much to arrive by accident.
    A new card type is expected to add its trigger line to the shared doctrine
    and put its paragraph in the `piloti-cards` skill, which is applied on every
    answering turn anyway and is a database row rather than a deploy.

    That doctrine now lives in `cards.catalog` and is rendered by the post-hoc
    card prompt as well, so it is no longer only this description's to spend —
    but it is still PAID here, on every turn, which is why the ceiling still
    measures `_build_tool_description()` end to end rather than the framing
    around it. Text added to the shared doctrine for the benefit of the batch
    generator shows up in this number, and that is the point: the per-turn cost
    is the scarce one. `test_prompt.py` caps what the post-hoc side adds on its
    own account.

    Raising this number is a decision, not a fix. It should come with a
    measurement of what the turn now costs in total. The measurement that
    raised it from 2,300 to 2,900, in o200k_base tokens per call:

        emit_card's description   2,086 -> 2,600   (+514, the craft arriving)
        piloti.j2's `<cards>`     1,272 ->   149   (-1,123, all but two sentences)
        describe_card's schema       69 ->     0   (unbound from the chat surface)
                                                   ---------
        net per call                                   -678

    So the ceiling went UP and the turn got CHEAPER, which is the only shape of
    argument that may move this number. The craft was always paid on every turn;
    it was paid in the system prompt, where nothing measured it.
    """

    #: cl100k_base tokens. Measured at 2,655 after the craft moved in (1,745
    #: before, under the old split). The slack is the same third-or-so it always
    #: was: this fails when the description has grown by roughly a third, which
    #: is far too much to arrive by accident.
    MAX_TOKENS = 2_900

    def test_the_tool_description_stays_under_the_ceiling(self):
        tiktoken = pytest.importorskip("tiktoken")
        encoding = tiktoken.get_encoding("cl100k_base")

        cost = len(encoding.encode(_build_tool_description()))

        assert cost <= self.MAX_TOKENS, (
            f"emit_card's description is {cost} tokens, over the {self.MAX_TOKENS} ceiling. "
            "Every turn pays this whether or not a card is emitted. If you added a card type, "
            "its trigger line AND its craft belong in `cards.catalog._CARD_TRIGGERS`, together — "
            "so what to cut is prose that repeats what another row already says, never the craft "
            "moved back out into a prompt where nothing counts it."
        )
