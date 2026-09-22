"""What a turn can know before its first call, decided rather than generated (ADR-0064).

Before the first LLM call the turn already holds the question, the subject
document, the project's confirmed facts and the inventory. ADR-0052 forbids
a label decided here from WITHHOLDING anything — the intent router it deleted
did exactly that — so every question asked of the decision model is one
whose answer can only ADD to the turn:

- ``needs_evidence``: whether the message needs a regulation, a project file
  or the building model read at all. False on a greeting, a thank-you, a
  memory note. What it gates is the PREFETCH below, never a tool.
- ``corpus``: which body of knowledge the answer most likely lives in. It
  chooses what to prefetch; every tool stays bound whatever it says.
- one ``noul`` per Richtlinien-Familie the corpus holds: which OIB documents
  the answer needs. The top ones are prefetched as family overviews, so the
  model's first call sees their Gliederung and scope and opens Punkte instead
  of searching for them (the audit's §5 b).
- one ``noul`` per content card type whose shape is NOT already in the
  taught envelope: the two most likely get their full shape attached to
  this turn's prompt, so a card the answer earns is written right first time.
- ``model``: whether the question is about the building model, which reads
  the one skill body too long to ride the prompt (``ifc-spatial-reasoning``)
  into this turn.

One request, every question over one state — the vendor evaluates them
independently — and the state is built from structured fields, never the
transcript. The effects are applied by the register (``_run_turn``) and the
agent (``PilotiAgent.run``: the prefetch runs as round 0 through the real
tools node, so it costs no budget, files its sources, stamps its hits and
is answered by the duplicate-fetch guard when the model asks again).

Every function here returns something a caller can act on without a
decision having run: ``TurnDecisions.none()`` prefetches nothing, attaches
nothing and inlines nothing, which is the turn as it ran before.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from collections.abc import Sequence
from dataclasses import dataclass
from dataclasses import field
from typing import Any

logger = logging.getLogger(__name__)

#: The slot the technical record is filed under: ``status:decision:turn``.
SLOT = "turn"

#: The knowledge tool the prefetch calls. A wire name (``configs/*.yml``).
KNOWLEDGE_SEARCH = "knowledge_search"
#: The one chat skill too long to ride the prompt (ADR-0063), read in on a
#: model-shaped turn. A skill name is a wire name (``SKILL.md`` frontmatter).
MODEL_SKILL = "ifc-spatial-reasoning"

#: Below this p(needs_evidence) nothing is prefetched. Deliberately low: a
#: false "no" costs the model its first round, a false "yes" costs one unread
#: grounding block.
NEEDS_EVIDENCE_THRESHOLD = 0.5
#: A family is prefetched at or above this; the top ``MAX_FAMILY_PREFETCH``.
#: Measured, not guessed: on the 27 loop-eval questions (2026-09-22,
#: ``tests/fixtures/herleitung/decision_eval_2026-09-22.csv``) the expected
#: family's probability ran 0.54-0.97 and no Bauordnung row's top family
#: passed 0.49, so 0.5 is recall 1.0 at precision 1.0 where 0.6 lost two
#: rows. Re-run ``task be:eval:decisions`` before moving it.
FAMILY_THRESHOLD = 0.5
MAX_FAMILY_PREFETCH = 2
#: A card type gets its shape attached at or above this; the top ``MAX_CARD_SHAPES``.
CARD_THRESHOLD = 0.6
MAX_CARD_SHAPES = 2
#: The chosen corpus must reach this before its prefetch runs.
CORPUS_THRESHOLD = 0.5
MODEL_THRESHOLD = 0.6

#: The corpora a question can live in, with the criteria the decider reads.
#: ``modell`` and ``none`` prefetch nothing; the others prefetch one search.
CORPUS_OPTIONS: Mapping[str, str] = {
    "baurecht": (
        "Austrian building law and standards: an OIB-Richtlinie, a Bauordnung of a Land, an ÖNORM, "
        "a Verordnung — a requirement, a limit, a class, a procedure, or what a regulation says."
    ),
    "projekt": (
        "The files of THIS project: a plan, a Bescheid, a report, a model, a submission, or what the "
        "project's own documents contain, show or require."
    ),
    "buero": "The office's archive: templates, earlier projects, standard details, house documents.",
    "modell": (
        "The building model (IFC/BIM): storeys, rooms, elements, dimensions, quantities, areas, heights, "
        "or anything measured or counted in the model."
    ),
    "none": (
        "No reading needed: a greeting, thanks, small talk, a request to remember or note something, a "
        "question about the assistant itself, or a task that only rewrites text already in the conversation."
    ),
}

#: What each Richtlinie is about, in the decider's language, so a German
#: question can be matched to the family whose subject it names.
FAMILY_SCOPE: Mapping[str, str] = {
    "1": "OIB-Richtlinie 1 — mechanical resistance and stability: load-bearing structure, Standsicherheit.",
    "2": (
        "OIB-Richtlinie 2 — fire safety: Brandschutz, Gebäudeklasse, Brandabschnitte, Fluchtwege, "
        "Feuerwiderstand, Rauchwarnmelder, fire brigade access; part 2.1 Betriebsbauten (industrial and "
        "commercial buildings), 2.2 Garagen (garages, parking), 2.3 Hochhäuser (high-rise)."
    ),
    "3": (
        "OIB-Richtlinie 3 — hygiene, health and environmental protection: Belichtung, Belüftung, "
        "daylight, ventilation, sanitary rooms, water, moisture, radon, waste."
    ),
    "4": (
        "OIB-Richtlinie 4 — safety in use and accessibility: Nutzungssicherheit, Barrierefreiheit, "
        "stairs, railings (Absturzsicherung), door widths, ramps, lifts, glazing."
    ),
    "5": "OIB-Richtlinie 5 — sound insulation: Schallschutz, airborne and impact sound, Luftschall, Trittschall.",
    "6": (
        "OIB-Richtlinie 6 — energy saving and thermal insulation: Wärmeschutz, Energieausweis, U-Werte, "
        "heating demand, thermal envelope."
    ),
}


@dataclass(frozen=True)
class TurnDecisions:
    """What the decision model said, as numbers; ``decided`` False when it did not run."""

    decided: bool = False
    needs_evidence: float | None = None
    corpus: str | None = None
    corpus_p: float = 0.0
    families: tuple[tuple[str, float], ...] = ()
    cards: tuple[tuple[str, float], ...] = ()
    model: float | None = None
    latency_ms: int = 0

    @staticmethod
    def none() -> TurnDecisions:
        return TurnDecisions()

    @property
    def wants_evidence(self) -> bool:
        return self.decided and (self.needs_evidence or 0.0) >= NEEDS_EVIDENCE_THRESHOLD

    @property
    def wants_model_skill(self) -> bool:
        return self.decided and (self.model or 0.0) >= MODEL_THRESHOLD

    def chosen_families(self) -> list[str]:
        ranked = sorted((f for f in self.families if f[1] >= FAMILY_THRESHOLD), key=lambda f: -f[1])
        return [key for key, _ in ranked[:MAX_FAMILY_PREFETCH]]

    def chosen_cards(self) -> list[str]:
        ranked = sorted((c for c in self.cards if c[1] >= CARD_THRESHOLD), key=lambda c: -c[1])
        return [card_type for card_type, _ in ranked[:MAX_CARD_SHAPES]]


@dataclass(frozen=True)
class TurnFacts:
    """What the decider is shown. Structured, bounded, never the transcript."""

    question: str
    focus_file_name: str | None = None
    project_facts: Mapping[str, str] = field(default_factory=dict)
    families: Sequence[Any] = ()
    project_files: int = 0
    archive_files: int = 0
    card_types: Sequence[tuple[str, str]] = ()
    offers_model_skill: bool = False

    def state(self) -> dict[str, Any]:
        state: dict[str, Any] = {"message": self.question[:1000], "language": "de"}
        if self.focus_file_name:
            state["open_document"] = self.focus_file_name
        if self.project_facts:
            state["project"] = dict(list(self.project_facts.items())[:12])
        state["corpus"] = {
            "regulation_families": [f"{family.label}: parts {', '.join(family.members)}" for family in self.families],
            "project_files": self.project_files,
            "archive_files": self.archive_files,
        }
        return state


def questions_for(facts: TurnFacts) -> dict[str, dict[str, Any]]:
    """Every question of the turn decision, keyed the way the answers are read back."""
    from aiq_agent.common.decisions import choice
    from aiq_agent.common.decisions import noul

    questions: dict[str, dict[str, Any]] = {
        "needs_evidence": noul(
            "Does answering this message require reading a regulation, a project document, the office "
            "archive or the building model?",
            true=(
                "The message asks what a rule requires, what a document contains, what applies to the "
                "project, or for a value, a class, a procedure, a comparison or a check."
            ),
            false=CORPUS_OPTIONS["none"],
        ),
        "corpus": choice("Where does the answer to this message most likely live?", CORPUS_OPTIONS),
    }
    for family in facts.families:
        scope = FAMILY_SCOPE.get(str(family.key), family.label)
        questions[f"family_{family.key}"] = noul(
            f"Does answering this message require reading {family.label}?",
            true=f"The message is about the subject of this Richtlinie. {scope}",
            false="The message is about another subject, another regulation, or needs no regulation.",
        )
    for card_type, doc in facts.card_types:
        questions[f"card_{card_type}"] = noul(
            f"Would the answer to this message be best shown, in part, as a '{card_type}' card?",
            true=f"The answer would contain exactly what this card shows: {doc}",
            false="The answer is prose, a value, or a different kind of structure.",
        )
    if facts.offers_model_skill:
        questions["model"] = noul(
            "Is this message about the building model (IFC/BIM) rather than about a regulation or a document?",
            true=CORPUS_OPTIONS["modell"],
            false="The message is about a regulation, a document, the office, or nothing that is measured in a model.",
        )
    return questions


async def decide_turn(facts: TurnFacts, *, organization_id: str | None = None) -> TurnDecisions:
    """One decision request for the turn; :meth:`TurnDecisions.none` when none ran."""
    from aiq_agent.common.decisions import decide

    questions = questions_for(facts)
    decision = await decide(facts.state(), questions, slot=SLOT, organization_id=organization_id)
    if decision is None:
        return TurnDecisions.none()
    corpus, distribution = decision.choice("corpus")
    families = tuple(
        (str(family.key), p) for family in facts.families if (p := decision.noul(f"family_{family.key}")) is not None
    )
    cards = tuple(
        (card_type, p) for card_type, _ in facts.card_types if (p := decision.noul(f"card_{card_type}")) is not None
    )
    decided = TurnDecisions(
        decided=True,
        needs_evidence=decision.noul("needs_evidence"),
        corpus=corpus,
        corpus_p=distribution.get(corpus or "", 0.0),
        families=families,
        cards=cards,
        model=decision.noul("model"),
        latency_ms=decision.latency_ms,
    )
    logger.info(
        "Turn decision in %d ms: evidence=%.2f corpus=%s(%.2f) families=%s cards=%s",
        decided.latency_ms,
        decided.needs_evidence or 0.0,
        decided.corpus,
        decided.corpus_p,
        decided.chosen_families(),
        decided.chosen_cards(),
    )
    return decided


def prefetch_calls(decisions: TurnDecisions, question: str) -> list[dict[str, Any]]:
    """The tool calls round 0 runs, as the agent's tools node reads them.

    The question itself, when the corpus is one the knowledge tool searches;
    and, when the question is NOT itself a family overview, the chosen
    families' overviews — ``knowledge_search`` recognises ``OIB-Richtlinie n``
    as a family query and returns every member's scope and Gliederung. Nothing
    for the model corpus (a measurement needs the model, not a search) and
    nothing when the decision did not run or said no evidence is needed.
    """
    if not decisions.wants_evidence:
        return []
    if decisions.corpus not in {"baurecht", "projekt", "buero"} or decisions.corpus_p < CORPUS_THRESHOLD:
        return []
    from aiq_agent.common.norm_registry import family_query_number

    query = " ".join((question or "").split())[:300]
    if not query:
        return []
    calls: list[dict[str, Any]] = [{"name": KNOWLEDGE_SEARCH, "args": {"query": query}}]
    if decisions.corpus == "baurecht" and family_query_number(query) is None:
        calls.extend(
            {"name": KNOWLEDGE_SEARCH, "args": {"query": f"OIB-Richtlinie {key}"}}
            for key in decisions.chosen_families()
        )
    return calls
