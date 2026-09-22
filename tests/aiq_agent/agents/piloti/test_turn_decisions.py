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
from aiq_agent.agents.piloti.decisions import decide_turn
from aiq_agent.agents.piloti.decisions import prefetch_calls
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
    return TurnFacts(question=question, families=FAMILIES, card_types=CARDS, offers_model_skill=True, **kwargs)


class TestWhatIsAsked:
    def test_one_question_per_family_and_per_card_beside_the_fixed_ones(self):
        questions = questions_for(_facts("Wie lang darf der Fluchtweg sein?"))
        assert set(questions) == {
            "needs_evidence",
            "corpus",
            "family_2",
            "family_4",
            "card_fire_compartment",
            "card_stair_diagram",
            "model",
        }
        assert questions["corpus"]["type"] == "choice"
        assert set(questions["corpus"]["criteria"]) == {"baurecht", "projekt", "buero", "modell", "none"}
        # The family question carries the Richtlinie's subject, in the decider's language.
        assert "Brandschutz" in questions["family_2"]["criteria"]["true"]
        # The card question carries the card's own index line.
        assert "fire compartments" in questions["card_fire_compartment"]["criteria"]["true"]

    def test_no_model_skill_offered_means_no_model_question(self):
        facts = TurnFacts(question="q", families=FAMILIES, card_types=CARDS, offers_model_skill=False)
        assert "model" not in questions_for(facts)

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
                "model": {"type": "noul", "noul": 0.05},
            },
            latency_ms=210,
        )
        with patch("aiq_agent.common.decisions.decide", new_callable=AsyncMock, return_value=decision):
            decided = await decide_turn(_facts("Brandabschnitte in GK 4?"))
        assert decided.decided and decided.wants_evidence
        assert decided.corpus == "baurecht" and decided.corpus_p == 0.8
        assert decided.chosen_families() == ["2"]
        assert decided.chosen_cards() == ["fire_compartment"]
        assert not decided.wants_model_skill
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
