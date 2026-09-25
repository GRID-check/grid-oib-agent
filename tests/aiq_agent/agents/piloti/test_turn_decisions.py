"""The turn-start decision (ADR-0064): what is asked, and what the answers may do.

Every effect is an ADDITION — a fetch run early, a shape attached, a skill
body read in place — and ``TurnDecisions.none()`` is the turn as it ran
before. The decision client is mocked at its seam; what is pinned is the
question set, the state's shape, and the mapping from probabilities to
effects.
"""

from __future__ import annotations

from unittest.mock import AsyncMock
from unittest.mock import patch

from aiq_agent.agents.piloti.decisions import TurnDecisions
from aiq_agent.agents.piloti.decisions import TurnFacts
from aiq_agent.agents.piloti.decisions import attached_card_types
from aiq_agent.agents.piloti.decisions import decide_turn
from aiq_agent.agents.piloti.decisions import prefetch_calls
from aiq_agent.agents.piloti.decisions import prefetch_query
from aiq_agent.agents.piloti.decisions import questions_for
from aiq_agent.common.decisions import Decision
from aiq_agent.common.norm_registry import oib_families

FAMILIES = oib_families(
    ["oib-rl_2_ausgabe_mai_2023.pdf", "oib-rl_2.1_ausgabe_mai_2023.pdf", "oib-rl_4_ausgabe_mai_2023.pdf"]
)
CARDS = [
    ("fire_compartment", "A storey divided into fire compartments."),
    ("stair_diagram", "A stair with its dimensions."),
]


def _facts(question: str, **kwargs) -> TurnFacts:
    return TurnFacts(question=question, families=FAMILIES, card_types=CARDS, **kwargs)


class TestWhatIsAsked:
    def test_one_question_per_family_and_per_card_beside_the_fixed_ones(self):
        questions = questions_for(_facts("Wie lang darf der Fluchtweg sein?"))
        assert set(questions) == {
            "needs_evidence",
            "corpus",
            "self_contained",
            "landesrecht",
            "land",
            "family_2",
            "family_4",
            "card_fire_compartment",
            "card_stair_diagram",
        }
        assert questions["corpus"]["type"] == "choice"
        assert set(questions["corpus"]["criteria"]) == {"baurecht", "projekt", "buero", "modell", "none"}
        # The family question carries the Richtlinie's subject, in the decider's language.
        assert "Brandschutz" in questions["family_2"]["criteria"]["true"]
        # The card question carries the card's own index line.
        assert "fire compartments" in questions["card_fire_compartment"]["criteria"]["true"]

    def test_skills_riding_the_prompt_get_a_choice_with_none_and_one_fits_noul_each(self):
        facts = TurnFacts(
            question="q", skills=[("brandschutz", "Brandabschnitt, Fluchtweg."), ("hygiene", "Aufenthaltsraum.")]
        )
        questions = questions_for(facts)
        assert set(questions["skill"]["criteria"]) == {"brandschutz", "hygiene", "none"}
        assert "fits_brandschutz" in questions and "fits_hygiene" in questions
        assert "Brandabschnitt" in questions["fits_brandschutz"]["criteria"]["true"]

    def test_the_previous_exchange_rides_the_state_bounded(self):
        state = TurnFacts(question="und in GK 4?", previous_message="x" * 1000, previous_answer="y" * 1000).state()
        assert len(state["previous_message"]) == 300 and len(state["previous_answer"]) == 300

    def test_the_state_is_structured_and_bounded(self):
        facts = _facts(
            "x" * 2000,
            focus_file_name="EG.pdf",
            project_facts={f"k{i}": "v" for i in range(20)},
            project_files=3,
            archive_files=7,
        )
        state = facts.state()
        assert len(state["message"]) == 1000 and state["language"] == "de"
        assert state["open_document"] == "EG.pdf"
        assert len(state["project"]) == 12
        assert state["corpus"]["regulation_families"] == [
            "OIB-Richtlinie 2: parts 2, 2.1",
            "OIB-Richtlinie 4: parts 4",
        ]
        assert state["corpus"] == {**state["corpus"], "project_files": 3, "archive_files": 7}


class TestWhatTheAnswersBecome:
    async def test_the_answers_are_read_back_by_key(self):
        decision = Decision(
            answers={
                "needs_evidence": {"type": "noul", "noul": 0.9},
                "corpus": {"type": "choice", "choice": "baurecht", "probabilities": {"baurecht": 0.8, "none": 0.2}},
                "family_2": {"type": "noul", "noul": 0.95},
                "family_4": {"type": "noul", "noul": 0.1},
                "card_fire_compartment": {"type": "noul", "noul": 0.7},
                "card_stair_diagram": {"type": "noul", "noul": 0.2},
            },
            latency_ms=210,
        )
        with patch("aiq_agent.common.decisions.decide", new_callable=AsyncMock, return_value=decision):
            decided = await decide_turn(_facts("Brandabschnitte in GK 4?"))
        assert decided.decided and decided.wants_evidence
        assert decided.corpus == "baurecht" and decided.corpus_p == 0.8
        assert decided.chosen_families() == ["2"]
        assert decided.chosen_cards() == ["fire_compartment"]
        assert decided.chosen_skill is None
        assert decided.latency_ms == 210

    async def test_no_decision_is_none_and_none_does_nothing(self):
        with patch("aiq_agent.common.decisions.decide", new_callable=AsyncMock, return_value=None):
            decided = await decide_turn(_facts("Hallo"))
        assert decided == TurnDecisions.none()
        assert not decided.wants_evidence and decided.chosen_cards() == [] and decided.chosen_families() == []
        assert prefetch_calls(decided, "Hallo") == []

    def test_the_top_two_families_and_cards_above_their_thresholds(self):
        decided = TurnDecisions(
            decided=True,
            needs_evidence=0.9,
            families=(("2", 0.51), ("4", 0.9), ("3", 0.7), ("6", 0.49)),
            cards=(("a", 0.59), ("b", 0.95), ("c", 0.8), ("d", 0.61)),
        )
        assert decided.chosen_families() == ["4", "3"]
        assert decided.chosen_cards() == ["b", "c"]


class TestThePrefetch:
    def _decided(self, corpus: str, p: float = 0.8, evidence: float = 0.9, families=(("2", 0.9),)) -> TurnDecisions:
        return TurnDecisions(decided=True, needs_evidence=evidence, corpus=corpus, corpus_p=p, families=families)

    def test_a_law_question_prefetches_itself_and_the_top_family_overview(self):
        calls = prefetch_calls(self._decided("baurecht"), "Wie lang darf der  Fluchtweg sein?")
        assert calls == [
            {"name": "knowledge_search", "args": {"query": "Wie lang darf der Fluchtweg sein?"}},
            {"name": "knowledge_search", "args": {"query": "OIB-Richtlinie 2"}},
        ]

    def test_a_family_question_is_its_own_overview_and_prefetches_once(self):
        calls = prefetch_calls(self._decided("baurecht"), "Was weißt du über die OIB 2?")
        assert calls == [{"name": "knowledge_search", "args": {"query": "Was weißt du über die OIB 2?"}}]

    def test_a_project_question_prefetches_the_question_only(self):
        assert prefetch_calls(self._decided("projekt"), "Was steht im Bescheid?") == [
            {"name": "knowledge_search", "args": {"query": "Was steht im Bescheid?"}}
        ]

    def test_the_model_corpus_and_none_prefetch_nothing(self):
        assert prefetch_calls(self._decided("modell"), "Wie hoch ist der Keller?") == []
        assert prefetch_calls(self._decided("none"), "Danke!") == []

    def test_no_evidence_or_an_unsure_corpus_prefetches_nothing(self):
        assert prefetch_calls(self._decided("baurecht", evidence=0.3), "q") == []
        assert prefetch_calls(self._decided("baurecht", p=0.4), "q") == []

    def test_a_decision_that_missed_its_budget_still_prefetches_a_family_question(self):
        """The decider rarely lands in 1.5 s; the family question is evidence by construction."""
        assert prefetch_calls(TurnDecisions.none(), "Was weißt du über die OIB 2?") == [
            {"name": "knowledge_search", "args": {"query": "Was weißt du über die OIB 2?"}}
        ]

    def test_without_a_decision_a_later_message_prefetches_nothing(self):
        """„Was sagt die OIB 2 dazu?" after a stair question is a follow-up; the
        decided path would refuse it, so the undecided one may not guess it
        is a family overview."""
        assert (
            prefetch_calls(
                TurnDecisions.none(),
                "Was sagt die OIB 2 dazu?",
                previous_message="Wie breit muss die Stiege sein?",
            )
            == []
        )

    def test_without_a_decision_nothing_else_is_guessed(self):
        assert prefetch_calls(TurnDecisions.none(), "Wie lang darf der Fluchtweg sein?") == []
        assert prefetch_calls(TurnDecisions.none(), "Hallo, was kannst du?") == []


class TestTheSkillsShapes:
    """The chosen skill's preferred cards ride the turn — what `use_skill` used to hand over."""

    SKILL_CARDS = {"brandschutz": ["fire_compartment", "egress_diagram"], "hygiene": ["daylight_incidence"]}

    def test_the_skills_cards_come_first_then_the_nouls_picks_capped_and_deduped(self):
        decided = TurnDecisions(
            decided=True,
            skill="brandschutz",
            skill_p=0.8,
            skill_fit=0.9,
            cards=(("egress_diagram", 0.9), ("stair_diagram", 0.7)),
        )
        assert attached_card_types(decided, self.SKILL_CARDS) == ["fire_compartment", "egress_diagram", "stair_diagram"]

    def test_the_cookbooks_abstention_a_low_fit_or_none_attaches_no_skill(self):
        name_match = TurnDecisions(decided=True, skill="brandschutz", skill_p=0.8, skill_fit=0.05)
        assert name_match.chosen_skill is None and attached_card_types(name_match, self.SKILL_CARDS) == []
        none = TurnDecisions(decided=True, skill="none", skill_p=0.9, skill_fit=None)
        assert none.chosen_skill is None
        unsure = TurnDecisions(decided=True, skill="hygiene", skill_p=0.5, skill_fit=0.9)
        assert unsure.chosen_skill is None
        # A weak fit on a confident choice still loads: a body is ~400 tokens and an offer.
        weak_fit = TurnDecisions(decided=True, skill="waermeschutz", skill_p=0.64, skill_fit=0.13)
        assert weak_fit.chosen_skill == "waermeschutz"

    async def test_the_choice_and_its_fit_are_read_back(self):
        decision = Decision(
            answers={
                "skill": {
                    "type": "choice",
                    "choice": "brandschutz",
                    "probabilities": {"brandschutz": 0.7, "none": 0.3},
                },
                "fits_brandschutz": {"type": "noul", "noul": 0.85},
                "self_contained": {"type": "noul", "noul": 0.2},
            }
        )
        with patch("aiq_agent.common.decisions.decide", new_callable=AsyncMock, return_value=decision):
            decided = await decide_turn(TurnFacts(question="und in GK 4?", skills=[("brandschutz", "b")]))
        assert decided.chosen_skill == "brandschutz" and decided.skill_fit == 0.85
        assert decided.self_contained == 0.2 and not decided.searchable


class TestALandLawQuestionIsLookedUpInRis:
    """A confident "this turns on a Bauordnung" starts the RIS lookup as round 0."""

    def _decided(self, landesrecht: float, land: str = "Tirol", land_p: float = 1.0, **kwargs) -> TurnDecisions:
        base = {"decided": True, "needs_evidence": 0.9, "corpus": "baurecht", "corpus_p": 0.95}
        return TurnDecisions(**{**base, **kwargs}, landesrecht=landesrecht, land=land, land_p=land_p)

    def test_the_question_and_the_land_are_looked_up_beside_the_search(self):
        calls = prefetch_calls(self._decided(0.93), "Wie groß muss der Abstand zur Nachbargrenze sein?")
        assert calls[-1] == {
            "name": "ris_lookup_tool",
            "args": {"question": "Wie groß muss der Abstand zur Nachbargrenze sein?", "jurisdiction": "Tirol"},
        }
        assert calls[0]["name"] == "knowledge_search"

    def test_an_unknown_or_unsure_land_is_left_to_the_lookup(self):
        for land, land_p in (("unknown", 1.0), ("Wien", 0.5)):
            (call,) = [
                c for c in prefetch_calls(self._decided(0.9, land, land_p), "Stellplätze?") if "question" in c["args"]
            ]
            assert "jurisdiction" not in call["args"]

    def test_below_the_bar_nothing_is_looked_up(self):
        """The highest OIB row measured in the whole decision scored 0.55; a lookup is two planner calls."""
        calls = prefetch_calls(self._decided(0.55), "Brauche ich Rauchwarnmelder in der Wohnung?")
        assert all(c["name"] != "ris_lookup_tool" for c in calls)

    def test_it_runs_when_the_knowledge_corpus_is_unsure(self):
        calls = prefetch_calls(self._decided(0.95, corpus="none", corpus_p=0.4), "Was ist bewilligungsfrei?")
        assert [c["name"] for c in calls] == ["ris_lookup_tool"]

    def test_a_follow_up_or_no_evidence_looks_up_nothing(self):
        assert prefetch_calls(self._decided(0.95, self_contained=0.1), "und in Wien?") == []
        assert prefetch_calls(self._decided(0.95, needs_evidence=0.2), "Danke") == []

    async def test_the_answers_are_read_back(self):
        decision = Decision(
            answers={
                "landesrecht": {"type": "noul", "noul": 0.91},
                "land": {"type": "choice", "choice": "Wien", "probabilities": {"Wien": 0.97, "unknown": 0.03}},
            }
        )
        with patch("aiq_agent.common.decisions.decide", AsyncMock(return_value=decision)):
            decided = await decide_turn(_facts("Welche Unterlagen für die Einreichung in Wien?"))
        assert (decided.wants_landesrecht, decided.chosen_land) == (True, "Wien")


class TestAFollowUpPrefetchesNothing:
    """The previous turn's passages are in the transcript; nothing to fetch ahead."""

    def test_a_follow_up_runs_no_round_zero_not_even_the_family_overview(self):
        decided = TurnDecisions(
            decided=True,
            needs_evidence=0.9,
            corpus="baurecht",
            corpus_p=0.8,
            families=(("2", 0.9),),
            self_contained=0.1,
        )
        assert prefetch_calls(decided, "und in GK 4?") == []

    def test_unknown_self_containment_counts_as_searchable(self):
        decided = TurnDecisions(decided=True, needs_evidence=0.9, corpus="projekt", corpus_p=0.8)
        assert prefetch_calls(decided, "Was steht im Bescheid?") == [
            {"name": "knowledge_search", "args": {"query": "Was steht im Bescheid?"}}
        ]


class TestTheOpenDocument:
    def test_a_project_question_with_a_file_open_is_pinned_to_it(self):
        decided = TurnDecisions(decided=True, needs_evidence=0.9, corpus="projekt", corpus_p=0.9)
        assert prefetch_calls(decided, "Fass den Plan zusammen.", focus_file_name="EG_Grundriss.pdf") == [
            {"name": "knowledge_search", "args": {"query": "Fass den Plan zusammen.", "file_name": "EG_Grundriss.pdf"}}
        ]

    def test_a_law_question_with_a_file_open_searches_the_corpus_not_the_file(self):
        decided = TurnDecisions(decided=True, needs_evidence=0.9, corpus="baurecht", corpus_p=0.9)
        calls = prefetch_calls(decided, "Wie lang darf der Fluchtweg sein?", focus_file_name="EG_Grundriss.pdf")
        assert calls == [{"name": "knowledge_search", "args": {"query": "Wie lang darf der Fluchtweg sein?"}}]


def test_the_prefetch_query_carries_no_trailing_blank():
    # A 300-character cut can land on a space; the search strips its query,
    # so a blank left here makes the warm-up embed a different string.
    question = "x" * 299 + " und mehr"
    assert prefetch_query(question) == prefetch_query(question).strip()
