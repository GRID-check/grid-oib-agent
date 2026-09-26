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
- ``family``, a choice over the Richtlinien-Familien the corpus holds and
  "none": which OIB document the answer needs. The pick is prefetched as a
  family overview, so the
  model's first call sees their Gliederung and scope and opens Punkte instead
  of searching for them (the audit's §5 b).
- one ``noul`` per content card type whose shape is NOT already in the
  taught envelope: the two most likely get their full shape attached to
  this turn's prompt, so a card the answer earns is written right first time.
- ``skill``, a choice over every skill the turn resolved with "none", and
  one ``skill_veto`` noul — does the message ask for something other than an
  expert answer — so a message that only names a subject („Was steht im
  Brandschutzkonzept?") gets no method pushed at it. What it may do: read the
  chosen skill's BODY into this turn's prompt — the one method the question
  is the subject of, ~400 tokens, or the IFC method on a model question —
  and attach its preferred card shapes beyond the three shapes the envelope
  teaches, the Markdown-written types and ``surface``. Inlining every short method cost ~4 600 tokens on every
  call for methods most turns never use (ADR-0063, amended); one chosen
  body costs a tenth of that and only when a question calls for it. The
  body stays an offer: the model decides whether to follow it, and the
  rest stay one catalog line each behind ``use_skill``.
- ``self_contained``: whether the message can be searched on its own. A
  follow-up („und in GK 4?") cannot, and searching the fragment would hand
  the model a grounding block about nothing. A follow-up prefetches
  NOTHING: the previous turn's passages are still in the transcript
  (``conversation._answer_update`` writes the whole turn back), which is
  the context the follow-up needs, and re-fetching it was the round every
  follow-up paid.

One request, every question over one state — the vendor evaluates them
independently — and the state is built from structured fields, never the
transcript. The effects are applied by the register (``_run_turn``) and the
agent (``PilotiAgent.run``: the prefetch runs as round 0 through the real
tools node, so it costs no budget, files its sources, stamps its hits and
is answered by the duplicate-fetch guard when the model asks again).

Every function here returns something a caller can act on without a
decision having run: ``TurnDecisions.none()`` attaches nothing and inlines
nothing, and prefetches nothing with one exception: a FIRST message that
names an OIB family („OIB 2") still gets its own search as round 0
(``_undecided_prefetch``, ADR-0064's amendment), so ``prefetch_calls`` on it
is not the turn as it ran before the decisions.
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

# Every threshold below acts at 0.7 or 0.8 (2026-09-26). Two numbers stand
# behind each: the loop-eval set the wording was tuned on
# (``task be:eval:decisions``), and a held-out set written blind to the
# wording (``tests/fixtures/decisions/holdout/turn_questions.yaml``, 30 rows,
# ``task be:eval:decisions:holdout``), scored once per structural change and
# never tuned on. Where the two disagree, the held-out number decided.

#: Below this p(needs_evidence) nothing is prefetched. A false "no" costs the
#: model its first round, a false "yes" one unread grounding block. Loop-eval:
#: questions 0.80-0.98, ten messages that need nothing 0.03-0.24; held-out
#: 30/30 on the right side of 0.8.
NEEDS_EVIDENCE_THRESHOLD = 0.8
#: The family choice's pick is prefetched at or above this. One choice over
#: the six Richtlinien and "none", not a noul per family: independent nouls
#: read each family's scope as a keyword list and scored a question whose
#: words were not on it low (Holzfassade → 2 at 0.27, Nachhallzeit → 5 at
#: 0.27, held-out). Held-out, the choice found 16-17 of 21 families at 0.7
#: against 15 for the reworded nouls and 9 for the original ones, with one
#: false family on a follow-up (which prefetches nothing). Loop-eval 22/22.
#: A choice picks one family, so one is prefetched.
FAMILY_THRESHOLD = 0.7
MAX_FAMILY_PREFETCH = 1
#: A card type gets its shape attached at or above this; the top ``MAX_CARD_SHAPES``.
#: ``norm_chain`` scored 0.60-0.69 on nine different rulings — a type that
#: fits every ruling a little is noise — while the picks that named the
#: answer's shape (a checklist of Unterlagen, two variants side by side)
#: scored 0.81-0.88. Each attached shape is tokens on every call of the turn.
CARD_THRESHOLD = 0.8
MAX_CARD_SHAPES = 2
#: The chosen corpus must reach this before its prefetch runs. Every
#: regulation question chose ``baurecht`` at 0.94-1.00.
CORPUS_THRESHOLD = 0.8
#: A skill's body and shapes ride the turn when the choice lands on it at
#: this probability and the veto does not reach ``SKILL_VETO_THRESHOLD``.
#: The decider reads each skill's catalog line AND the heading its body
#: opens with (``skill_option``): „Treppe, Geländer, Türbreite" alone never
#: said Barrierefreiheit (0.61 → 0.99 with the heading). The veto is one
#: question — does the message ask for something other than an expert
#: answer (a file listed or summarised, a mail) — replacing a per-skill
#: "fits" noul that rated right picks as low as 0.12. Loop-eval: right picks
#: 0.87-1.00 with veto 0.03-0.27; „Was steht im Brandschutzkonzept?" veto
#: 0.80. Held-out 25/30 loaded exactly the expected skill or none (24/30
#: before); the misses are a skill whose description does not cover the
#: topic (radon under `hygiene`) and choices under 0.7.
SKILL_THRESHOLD = 0.7
SKILL_VETO_THRESHOLD = 0.7
#: Below this p(self_contained) the message itself is not searched. Loop-eval
#: standalone 0.79-0.95, follow-ups at most 0.40; held-out 25/27 at 0.8 and
#: 24/27 at 0.7, where a follow-up crossed — so 0.8.
SELF_CONTAINED_THRESHOLD = 0.8
#: How many card shapes the turn may attach in all (skill's plus the nouls').
MAX_ATTACHED_SHAPES = 5

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
        "daylight, ventilation, sanitary rooms, water, moisture and protection against ground moisture "
        "(Feuchtigkeit, erdberührte Bauteile, Abdichtung), radon, waste."
    ),
    "4": (
        "OIB-Richtlinie 4 — safety in use and accessibility: Nutzungssicherheit, Barrierefreiheit, "
        "stairs, railings (Absturzsicherung), door widths, ramps, lifts, glazing."
    ),
    "5": "OIB-Richtlinie 5 — sound insulation: Schallschutz, airborne and impact sound, Luftschall, Trittschall.",
    "6": (
        "OIB-Richtlinie 6 — energy saving and thermal insulation: Wärmeschutz, Energieausweis, U-Werte, "
        "heating demand, thermal envelope, and summer overheating protection (sommerlicher Wärmeschutz, "
        "Überwärmung, Verglasung, Sonnenschutz)."
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
    skill: str | None = None
    skill_p: float = 0.0
    #: p(the message asks for something other than an expert answer); a veto on the skill.
    skill_veto: float | None = None
    self_contained: float | None = None
    latency_ms: int = 0

    @staticmethod
    def none() -> TurnDecisions:
        return TurnDecisions()

    @property
    def wants_evidence(self) -> bool:
        return self.decided and (self.needs_evidence or 0.0) >= NEEDS_EVIDENCE_THRESHOLD

    @property
    def chosen_skill(self) -> str | None:
        """The skill whose body and card shapes ride this turn, or None (the cookbook's abstention)."""
        if not self.decided or not self.skill or self.skill == "none":
            return None
        if self.skill_p < SKILL_THRESHOLD or (self.skill_veto or 0.0) >= SKILL_VETO_THRESHOLD:
            return None
        return self.skill

    @property
    def searchable(self) -> bool:
        """Whether the message itself is worth a search: unknown counts as yes."""
        return self.self_contained is None or self.self_contained >= SELF_CONTAINED_THRESHOLD

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
    #: ``(name, description)`` of every skill the turn resolved — the choice's options.
    skills: Sequence[tuple[str, str]] = ()
    #: The user's previous message, bounded — what a follow-up refers to.
    previous_message: str | None = None
    #: The opening of the assistant's previous answer, bounded — the subject
    #: a follow-up continues, which the previous question alone may not name.
    previous_answer: str | None = None

    def state(self) -> dict[str, Any]:
        state: dict[str, Any] = {"message": self.question[:1000], "language": "de"}
        if self.previous_message:
            state["previous_message"] = self.previous_message[:300]
        if self.previous_answer:
            state["previous_answer"] = self.previous_answer[:300]
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


def skill_option(skill: Any) -> tuple[str, str]:
    """A skill as the decider's option: its catalog line, then the heading its body opens with.

    The catalog line is written for the model and is terse („Treppe, Geländer,
    Türbreite"); the heading says what the method is for („Eine Frage zu
    Nutzungssicherheit oder Barrierefreiheit beantworten"). The decider reads
    both; the model's catalog line is unchanged.
    """
    description = " ".join(str(getattr(skill, "description", "") or "").split())
    heading = next(
        (line[2:].strip() for line in str(getattr(skill, "body", "") or "").splitlines() if line.startswith("# ")),
        "",
    )
    return str(skill.name), f"{description} — {heading}" if heading else description


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
    if facts.families:
        options = {
            str(family.key): f"{family.label}: {FAMILY_SCOPE.get(str(family.key), family.label)}"
            for family in facts.families
        }
        options["none"] = (
            "No OIB-Richtlinie: another regulation (a Bauordnung, an ÖNORM), a project file, or no regulation."
        )
        questions["family"] = choice(
            "Which OIB-Richtlinie's subject is this message about? Compare the subjects; pick the one the "
            "message is about.",
            options,
        )
    for card_type, doc in facts.card_types:
        questions[f"card_{card_type}"] = noul(
            f"Would the answer to this message be best shown, in part, as a '{card_type}' card?",
            true=f"The answer would contain exactly what this card shows: {doc}",
            false="The answer is prose, a value, or a different kind of structure.",
        )
    questions["self_contained"] = noul(
        "Can this message be searched for on its own, without the previous message, and still find what it asks about?",
        true=(
            "The message names its own subject — a rule, a regulation, a document or folder of the project, a "
            "building element, a value, a situation or variants to compare — so a search for it finds what it "
            "asks about, however short it is."
        ),
        false=(
            "The message refers to something only the previous message names — 'und in GK 4?', 'was gilt "
            "dort?', 'und das zweite?' — or is a bare follow-up word such as 'warum', 'genauer', 'mehr'."
        ),
    )
    if facts.skills:
        options = {name: description for name, description in facts.skills}
        options["none"] = "No listed working method is about this message, or it needs none."
        questions["skill"] = choice(
            "Which of these working methods, if any, is the one for this message? Read what each does, not its name.",
            options,
        )
        questions["skill_veto"] = noul(
            "Does this message ask for something other than an expert answer about building regulations or the "
            "building?",
            true=(
                "It asks to list, open or summarise a file or folder, to write a mail or a note, to rephrase "
                "text, or it is thanks or small talk — even when it names a subject such as Brandschutz."
            ),
            false="It asks what applies, what is required, what a value is, or how to plan or check something.",
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
    _, family_distribution = decision.choice("family")
    families = tuple(
        (str(family.key), family_distribution[str(family.key)])
        for family in facts.families
        if str(family.key) in family_distribution
    )
    cards = tuple(
        (card_type, p) for card_type, _ in facts.card_types if (p := decision.noul(f"card_{card_type}")) is not None
    )
    skill, skill_distribution = decision.choice("skill")
    decided = TurnDecisions(
        decided=True,
        needs_evidence=decision.noul("needs_evidence"),
        corpus=corpus,
        corpus_p=distribution.get(corpus or "", 0.0),
        families=families,
        cards=cards,
        skill=skill,
        skill_p=skill_distribution.get(skill or "", 0.0),
        skill_veto=decision.noul("skill_veto"),
        self_contained=decision.noul("self_contained"),
        latency_ms=decision.latency_ms,
    )
    logger.info(
        "Turn decision in %d ms: evidence=%.2f corpus=%s(%.2f) families=%s skill=%s cards=%s self_contained=%s",
        decided.latency_ms,
        decided.needs_evidence or 0.0,
        decided.corpus,
        decided.corpus_p,
        decided.chosen_families(),
        decided.chosen_skill,
        decided.chosen_cards(),
        decided.self_contained,
    )
    return decided


def prefetch_query(question: str | None) -> str:
    """The question as round 0 searches it: whitespace folded, at most 300 characters.

    One definition, because the turn-start warm-up embeds this exact string
    and a warm-up for a different string is a wasted round trip.
    """
    # Stripped after the cut: a cut on a space would leave one, and the search
    # strips its query, so the warm-up would have embedded another string.
    return " ".join((question or "").split())[:300].rstrip()


def prefetch_calls(
    decisions: TurnDecisions,
    question: str,
    *,
    focus_file_name: str | None = None,
    previous_message: str | None = None,
) -> list[dict[str, Any]]:
    """The tool calls round 0 runs, as the agent's tools node reads them.

    The question itself, when the corpus is one the knowledge tool searches
    and the message can be searched on its own — pinned to the open document
    (``file_name``) when one is open and the corpus is the project's or the
    office's own files, which is the audit's cleanest case: the subject was
    known before the model ran, and a pinned lookup skips the judge. A
    message that cannot be searched on its own (a follow-up) prefetches
    nothing: the previous turn's passages are in the transcript; and,
    when the question is NOT itself a family overview, the chosen
    families' overviews — ``knowledge_search`` recognises ``OIB-Richtlinie n``
    as a family query and returns every member's scope and Gliederung. Nothing
    for the model corpus (a measurement needs the model, not a search) and
    nothing when the decision said no evidence is needed.

    When the decision did NOT run, a question that names an OIB family
    („Was weißt du über die OIB 2?") still prefetches its own search: that
    is the evidence question by construction, and without this a missed
    decision silently took the prefetch with it and the model paid a whole
    round for the same search. How often it misses is the endpoint's latency:
    p50 2.7 s against the 1.5 s budget, 10 of 12 over, on 2026-09-23; a median
    0.54 s, p90 0.62 s over two suites on 2026-09-24, with no change to the
    call in between (ADR-0064's amendment). A two-word first message („OIB
    2") is never decided at all (``register._decide_turn``).
    Only on a FIRST message (``previous_message is None``): without the
    decision's ``self_contained`` answer a later message may be a follow-up
    („Was sagt die OIB 2 dazu?"), which the decided path refuses to prefetch,
    and a family overview would fill round 0 with the wrong subject.
    """
    if not decisions.decided:
        return [] if previous_message is not None else _undecided_prefetch(question)
    if not decisions.wants_evidence or not decisions.searchable:
        return []
    if decisions.corpus not in {"baurecht", "projekt", "buero"} or decisions.corpus_p < CORPUS_THRESHOLD:
        return []
    from aiq_agent.common.norm_registry import family_query_number

    query = prefetch_query(question)
    if not query:
        return []
    args: dict[str, Any] = {"query": query}
    if focus_file_name and decisions.corpus in {"projekt", "buero"}:
        args["file_name"] = focus_file_name
    calls: list[dict[str, Any]] = [{"name": KNOWLEDGE_SEARCH, "args": args}]
    if decisions.corpus == "baurecht" and family_query_number(query) is None:
        calls.extend(
            {"name": KNOWLEDGE_SEARCH, "args": {"query": f"OIB-Richtlinie {key}"}}
            for key in decisions.chosen_families()
        )
    return calls


def _undecided_prefetch(question: str) -> list[dict[str, Any]]:
    """The prefetch a question earns without a decision: its own search, when it names a family."""
    from aiq_agent.common.norm_registry import family_query_number

    query = prefetch_query(question)
    if not query or family_query_number(query) is None:
        return []
    return [{"name": KNOWLEDGE_SEARCH, "args": {"query": query}}]


def attached_card_types(decisions: TurnDecisions, skill_cards: Mapping[str, Sequence[str]]) -> list[str]:
    """The card types whose full shape rides this turn's prompt, in order, capped.

    The chosen skill's preferred cards first — the shapes ``use_skill`` used
    to hand over with the body — then the types the card nouls picked; each
    once, at most ``MAX_ATTACHED_SHAPES``. The caller's lists already leave
    out the three shapes the envelope teaches (``ENVELOPE_SHAPE_TYPES``), the
    Markdown-written types (``MARKDOWN_CARD_TYPES``) and ``surface``
    (``CHAT_ONLY_CARD_TYPES``).
    """
    ordered: list[str] = []
    skill = decisions.chosen_skill
    for card_type in [*(skill_cards.get(skill, ()) if skill else ()), *decisions.chosen_cards()]:
        if card_type not in ordered:
            ordered.append(card_type)
    return ordered[:MAX_ATTACHED_SHAPES]
