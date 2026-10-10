"""Check each fingerprint value the closed-project reading proposes against its own quote (ADR-0064 use 12).

The fingerprint pen (``project_experience.extract_fingerprint``) answers the
intake's closed vocabularies — Bundesland, Bauweise, uses, kind of work, the
OIB edition — each with a quote, and code already checks that the quote is in
the text the pen read. Code cannot check that the quote SAYS the value: a pen
that cites „Brettsperrholz-Decken über dem Stahlbeton-Sockel" for Bauweise
„Massivbau", or „Baubehörde Wien" for a project in Niederösterreich, passes
every check today and becomes a suggestion the similarity ranking reads
(ADR-0096: a suggestion ranks until a person corrects it).

So one ``stated`` noul per proposed token asks the decision model exactly
that, over the quote and the value, nothing else. A token it rejects is not
suggested; a value with no token left is dropped. A token it could not judge
stays, so a decision model that is down leaves the reading as it was.

The Gebäudeklasse is not checked. The pen may derive it from heights and
floors (``docs/roadmap/office-experience.md``: arithmetic, not a classifier's
job), and a quote that gives the heights does not state the class in words: the
check would drop exactly the derivations the pen is there for.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from collections.abc import Sequence
from typing import TYPE_CHECKING
from typing import Any

if TYPE_CHECKING:
    from aiq_agent.knowledge.project_experience import FingerprintValue
    from aiq_agent.knowledge.project_experience import VocabularyEntry

logger = logging.getLogger(__name__)

#: The decision slot (``status:decision:experience_verify``, ``decide.experience_verify``).
SLOT = "experience_verify"

#: p(stated) below which a proposed token is not suggested: only a clear
#: contradiction. Measured (``decision_eval_office.py verify``, 10 Oct 2026, 32
#: hand-labelled quotes from the fixture office, 17 stating their value): no
#: quote stating a wrong value scored above 0.32, but quotes that state the
#: value only through what a reader knows scored low — „Stadtgemeinde
#: Mödling" for Niederösterreich 0.24, „Klassenräume" for Bildung 0.19 in one
#: run and 0.14 in the next. At 0.5 the check dropped 5-6 of 17 correct values.
#: At 0.1 it keeps all 17 in both runs and still rejects the pen's realistic
#: slips (5-6 of 15): Holzbau quoted as Massivbau 0.04, the 2019 edition offered
#: as 2015 0.05, a factory hall offered as housing 0.03.
STATED_THRESHOLD = 0.1

#: Keys the check leaves to the pen: their value may be derived, not stated.
UNCHECKED_KEYS = frozenset({"gebaeudeklasse"})

#: How many of a value's quotes the decider reads.
MAX_QUOTES = 3

#: The facts as a German reader names them; the state carries the user's language, the question English.
FACT_LABELS = {
    "bundesland": "Bundesland",
    "bauweise": "Bauweise",
    "nutzungen": "Nutzung",
    "vorhabensart": "Art des Vorhabens",
    "oib_ausgabe": "OIB-Richtlinien-Ausgabe, nach der geplant wurde",
}

STATED_QUESTION = {
    "type": "noul",
    "instructions": (
        "The quotes come from one building project's own documents. Do they state that this project's fact, "
        "named in the state, has the value named in the state?"
    ),
    "criteria": {
        "true": (
            "The quoted words say so about this project, in these or equivalent words (a place in that "
            "Bundesland, a construction of that kind, a use of that kind, the named edition)."
        ),
        "false": (
            "The quotes say something else, name the value only for a neighbour, a product, a norm or a "
            "comparison, or do not concern this fact at all."
        ),
    },
}


def _label(entry: VocabularyEntry, token: str) -> str:
    return next((option.label for option in entry.options if option.token == token), token)


def token_state(key: str, label: str, quotes: Sequence[str]) -> dict[str, Any]:
    return {
        "fact": FACT_LABELS.get(key, key),
        "value": label,
        "quotes": [quote[:300] for quote in quotes[:MAX_QUOTES]],
        "language": "de",
    }


def _tokens(value: FingerprintValue) -> list[str]:
    return [value.value] if isinstance(value.value, str) else list(value.value)


def verify_fingerprint(
    values: Sequence[FingerprintValue],
    vocabulary: Mapping[str, VocabularyEntry],
    *,
    organization_id: str | None = None,
) -> list[FingerprintValue]:
    """The values whose quotes state them; unchecked keys and undecided tokens kept. Never raises."""
    asked: list[tuple[int, str]] = []
    states: list[dict[str, Any]] = []
    for index, value in enumerate(values):
        entry = vocabulary.get(value.key)
        if value.key in UNCHECKED_KEYS or entry is None:
            continue
        quotes = [evidence.quote for evidence in value.evidence]
        for token in _tokens(value):
            asked.append((index, token))
            states.append(token_state(value.key, _label(entry, token), quotes))
    if not states:
        return list(values)
    try:
        from aiq_agent.common.decisions import decide_many_blocking

        decided = decide_many_blocking(states, {"stated": STATED_QUESTION}, slot=SLOT, organization_id=organization_id)
    except Exception:  # noqa: BLE001 — the reading stands as it was
        logger.debug("Fingerprint verification failed", exc_info=True)
        return list(values)
    rejected: dict[int, set[str]] = {}
    for (index, token), decision in zip(asked, decided, strict=True):
        p = decision.noul("stated") if decision is not None else None
        if p is not None and p < STATED_THRESHOLD:
            rejected.setdefault(index, set()).add(token)
    kept = []
    for index, value in enumerate(values):
        dropped = rejected.get(index, set())
        if not dropped:
            kept.append(value)
            continue
        tokens = [token for token in _tokens(value) if token not in dropped]
        logger.info("Fingerprint %s: the quotes do not state %s", value.key, sorted(dropped))
        if not tokens:
            continue
        kept.append(value.model_copy(update={"value": tokens if isinstance(value.value, list) else tokens[0]}))
    return kept
