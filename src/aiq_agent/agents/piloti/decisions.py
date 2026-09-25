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
- ``skill``, a choice over every skill the turn resolved with "none", and
  one "fits" noul per skill (TypeSafe's own skill-suggestion cookbook: rank,
  then verify the candidate does the specific thing asked; its abstention
  is what keeps a wrong skill from being pushed). What it may do: read the
  chosen skill's BODY into this turn's prompt — the one method the question
  is the subject of, ~400 tokens, or the IFC method on a model question —
  and attach its preferred card shapes beyond the three shapes the envelope
  teaches, the Markdown-written types and ``surface``. Inlining every short method cost ~4 600 tokens on every
  call for methods most turns never use (ADR-0063, amended); one chosen
  body costs a tenth of that and only when a question calls for it. The
  body stays an offer: the model decides whether to follow it, and the
  rest stay one catalog line each behind ``use_skill``.
- ``landesrecht`` and ``land``: whether the answer turns on a Land's
  building or planning law (a Bauordnung, a Bautechnikgesetz, a permit
  procedure), and which Land — from the message first, then the project's
  facts. A confident yes prefetches ``ris_lookup`` as round 0, with the Land
  when the decider named one. The Bauordnung questions were the slowest in
  the answer suite, serial RIS rounds before the first passage was read;
  the lookup itself decides the law and the §§, this only starts it early.
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
#: The RIS tool the prefetch calls, by the name the chat surface binds it
#: under. A deployment without RIS does not bind it, and round 0 drops a call
#: to an unbound tool (``PilotiAgent._prefetch_node``).
RIS_LOOKUP = "ris_lookup_tool"

#: Below this p(needs_evidence) nothing is prefetched. A false "no" costs the
#: model its first round, a false "yes" one unread grounding block. Measured
#: 2026-09-25: ten messages that need nothing (greetings, thanks, a memory
#: note, rewrite and e-mail requests) at 0.03-0.24, the 35 loop-eval and
#: follow-up questions at 0.70-0.98 (standalone 0.82-0.98), so 0.6 sits in
#: the gap with room on both sides.
NEEDS_EVIDENCE_THRESHOLD = 0.6
#: A family is prefetched at or above this; the top ``MAX_FAMILY_PREFETCH``.
#: Measured, not guessed: on the 27 loop-eval questions (2026-09-22,
#: ``tests/fixtures/herleitung/decision_eval_2026-09-22.csv``) the expected
#: family's probability ran 0.54-0.97 and no Bauordnung row's top family
#: passed 0.49, so 0.5 is recall 1.0 at precision 1.0 where 0.6 lost two
#: rows. Re-run ``task be:eval:decisions`` before moving it.
FAMILY_THRESHOLD = 0.5
MAX_FAMILY_PREFETCH = 2
#: A card type gets its shape attached at or above this; the top ``MAX_CARD_SHAPES``.
#: 0.7, not 0.6: on the 2026-09-25 run ``norm_chain`` scored 0.60-0.69 on nine
#: different rulings — a type that fits every ruling a little is noise — while
#: the picks that named the answer's shape (a guardrail check, a checklist of
#: Unterlagen, two variants side by side) scored 0.73-0.87. Each attached
#: shape is tokens on every call of the turn.
CARD_THRESHOLD = 0.7
MAX_CARD_SHAPES = 2
#: The chosen corpus must reach this before its prefetch runs. Every
#: regulation question chose ``baurecht`` at 0.94-1.00 on the 2026-09-25 run;
#: the one row below 0.7 was a folder listing („Was liegt im Ordner
#: Brandschutz?", ``projekt`` 0.34), which ``surface_documents`` answers and a
#: search of the question does not.
CORPUS_THRESHOLD = 0.7
#: A skill's body and shapes ride the turn when the choice lands on it at
#: this probability AND its own "fits" noul is not near zero. Measured on the
#: loop-eval set (``decision_eval_2026-09-22.csv``): the choice was right or
#: abstained on every row, while the fit noul ran 0.11-0.88 on rows where
#: the method plainly applied (Schallschutz → waermeschutz at 0.13, a
#: Holzfassade → brandschutz at 0.26). The cookbook's 0.30 on the fit was
#: set for loads that cost more than this one — a body is ~400 tokens and an
#: offer — so here the choice carries the decision and the fit only vetoes
#: a name-match (``ordner-brandschutz-listing`` → brandschutz at 0.59/0.13).
SKILL_THRESHOLD = 0.6
SKILL_FIT_THRESHOLD = 0.1
#: At or above this p(landesrecht) the question is looked up in RIS as round 0.
#: Measured 2026-09-25 inside the whole turn decision (``task
#: be:eval:decisions``, two runs): the five Bauordnung rows at 0.72-0.96, the
#: highest OIB row 0.54-0.55 (Rauchwarnmelder). Asked alone the same
#: question scores higher — „Wie hoch dürfen wir in Bauklasse I bauen" 0.88
#: alone, 0.72 beside the twenty other questions — so the threshold is set on
#: the state production sends, mid-gap. Asked alone, five project-fact
#: variants (the Land only in the project: „Wie groß muss der Abstand zur
#: Nachbargrenze sein?" in Innsbruck) scored 0.87-0.93 and a Gebäudeklasse
#: question in a Tirol project 0.62. A wrong yes costs a lookup (up to two
#: small planner calls and two RIS downloads); a miss, the round it saves.
LANDESRECHT_THRESHOLD = 0.65
#: The Land is passed to the lookup at or above this; below, the lookup reads
#: it from the question and the project brief itself. Every row the Land was
#: knowable for chose it at 1.00; the rest chose ``unknown`` at 0.96-1.00.
LAND_THRESHOLD = 0.8

#: The Länder, keyed as ``ris_lookup``'s ``jurisdiction`` takes them.
LAND_OPTIONS: Mapping[str, str] = {
    "Wien": "Wien (Vienna)",
    "Niederösterreich": "Niederösterreich (Lower Austria)",
    "Oberösterreich": "Oberösterreich (Upper Austria)",
    "Salzburg": "Salzburg",
    "Tirol": "Tirol (Tyrol)",
    "Vorarlberg": "Vorarlberg",
    "Kärnten": "Kärnten (Carinthia)",
    "Steiermark": "Steiermark (Styria)",
    "Burgenland": "Burgenland",
    "unknown": "Neither the message nor the project names or implies a Land.",
}

#: Below this p(self_contained) the message itself is not searched.
#: Standalone questions 0.71-0.95, follow-ups 0.02-0.25 (2026-09-25).
SELF_CONTAINED_THRESHOLD = 0.6
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
    skill: str | None = None
    skill_p: float = 0.0
    skill_fit: float | None = None
    self_contained: float | None = None
    landesrecht: float | None = None
    land: str | None = None
    land_p: float = 0.0
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
        if self.skill_p < SKILL_THRESHOLD or (self.skill_fit or 0.0) < SKILL_FIT_THRESHOLD:
            return None
        return self.skill

    @property
    def searchable(self) -> bool:
        """Whether the message itself is worth a search: unknown counts as yes."""
        return self.self_contained is None or self.self_contained >= SELF_CONTAINED_THRESHOLD

    @property
    def wants_landesrecht(self) -> bool:
        return self.decided and (self.landesrecht or 0.0) >= LANDESRECHT_THRESHOLD

    @property
    def chosen_land(self) -> str | None:
        """The Land to hand the lookup, or None to let it read one itself."""
        if not self.decided or not self.land or self.land == "unknown" or self.land_p < LAND_THRESHOLD:
            return None
        return self.land

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
    questions["landesrecht"] = noul(
        "Does answering this message require the law of an Austrian Land — a Bauordnung, Bautechnikgesetz, "
        "Raumordnungsgesetz, Garagengesetz, Baupolizeigesetz or a Land's Verordnung — and not only an "
        "OIB-Richtlinie or a technical standard?",
        true=(
            "The message turns on a Land's building or planning law: a permit or notification procedure, the "
            "documents a submission needs, what is exempt from a permit, building height or distances under the "
            "Bauordnung, parking obligations, zoning, or what a named Land requires."
        ),
        false=(
            "The message asks what an OIB-Richtlinie or an ÖNORM requires technically (fire resistance, escape "
            "routes, railings, U-values, sound insulation), about a project document or the building model, or "
            "needs no law."
        ),
    )
    questions["land"] = choice(
        "Which Austrian Land's law applies to this message? Read the message first, then the project's facts.",
        LAND_OPTIONS,
    )
    questions["self_contained"] = noul(
        "Can this message be searched for on its own, without the previous message, and still find what it asks about?",
        true=("The message names its own subject: the rule, the document, the element, the value it asks about."),
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
        for name, description in facts.skills:
            questions[f"fits_{name}"] = noul(
                f"Does the working method '{name}' do the specific thing this message asks for?",
                true=f"The message is exactly the case this method is written for: {description}",
                false="The message is about something else, or only shares a word with the method's name.",
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
    skill, skill_distribution = decision.choice("skill")
    land, land_distribution = decision.choice("land")
    decided = TurnDecisions(
        decided=True,
        needs_evidence=decision.noul("needs_evidence"),
        corpus=corpus,
        corpus_p=distribution.get(corpus or "", 0.0),
        families=families,
        cards=cards,
        skill=skill,
        skill_p=skill_distribution.get(skill or "", 0.0),
        skill_fit=decision.noul(f"fits_{skill}") if skill and skill != "none" else None,
        self_contained=decision.noul("self_contained"),
        landesrecht=decision.noul("landesrecht"),
        land=land,
        land_p=land_distribution.get(land or "", 0.0),
        latency_ms=decision.latency_ms,
    )
    logger.info(
        "Turn decision in %d ms: evidence=%.2f corpus=%s(%.2f) families=%s skill=%s cards=%s self_contained=%s "
        "landesrecht=%s land=%s",
        decided.latency_ms,
        decided.needs_evidence or 0.0,
        decided.corpus,
        decided.corpus_p,
        decided.chosen_families(),
        decided.chosen_skill,
        decided.chosen_cards(),
        decided.self_contained,
        decided.landesrecht,
        decided.chosen_land,
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
    query = prefetch_query(question)
    if not query:
        return []
    ris = _ris_prefetch(decisions, query)
    if decisions.corpus not in {"baurecht", "projekt", "buero"} or decisions.corpus_p < CORPUS_THRESHOLD:
        return ris
    from aiq_agent.common.norm_registry import family_query_number

    args: dict[str, Any] = {"query": query}
    if focus_file_name and decisions.corpus in {"projekt", "buero"}:
        args["file_name"] = focus_file_name
    calls: list[dict[str, Any]] = [{"name": KNOWLEDGE_SEARCH, "args": args}]
    if decisions.corpus == "baurecht" and family_query_number(query) is None:
        calls.extend(
            {"name": KNOWLEDGE_SEARCH, "args": {"query": f"OIB-Richtlinie {key}"}}
            for key in decisions.chosen_families()
        )
    return [*calls, *ris]


def _ris_prefetch(decisions: TurnDecisions, query: str) -> list[dict[str, Any]]:
    """The RIS lookup a Land-law question earns: the question, and the Land when the decider named it."""
    if not decisions.wants_landesrecht:
        return []
    args: dict[str, Any] = {"question": query}
    if decisions.chosen_land:
        args["jurisdiction"] = decisions.chosen_land
    return [{"name": RIS_LOOKUP, "args": args}]


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
