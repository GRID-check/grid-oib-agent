"""The SECOND kind of grounding, and the guard that keeps it in its lane.

The overconfidence gate in :mod:`.markers` was written against one kind of
evidence: a citation the verifier could resolve to a retrieved passage. That is
the right gate for a claim about the Bauordnung, and it is the wrong gate for a
claim about a building — because an IFC measurement has no passage to cite. It
carries something else instead, and arguably something stronger: a
``provenance`` (declared/computed/inferred), an absolute ``tolerance``, a
``method`` string a reviewer can read back, and the GlobalIds the value was
derived from (``ifc_spatial.envelope.Answer``). It is REPRODUCIBLE, which no
quotation is.

So a measured answer used to be capped to "low" for lacking evidence it
structurally cannot have. This module supplies the missing signal — and, much
more importantly, the guard that stops that signal from laundering anything.

## The laundering problem

One answer routinely mixes two claim types:

    (a) „Der Keller ist 2,70 m hoch"            — measured, reproducible
    (b) „…und erfüllt damit OIB 4 Punkt 2.1"    — a legal claim needing a quote

If a measurement simply satisfied the gate, (b) would ride out at the model's
self-reported level on the strength of (a)'s evidence. That is strictly worse
than the over-hedging it replaces: over-hedging annoys, but an unverified
assertion about the Bauordnung presented confidently — in a compliance product,
on a drawing an architect signs — is a liability. Two independent brakes:

1. :func:`answer_mentions_normative_claim` — when an answer WITHOUT verified
   citation grounding talks about the law at all, measurement grounding is
   withheld and the answer stays at "low", reported as
   ``normative_claim_uncited`` rather than resolved silently.
2. Measurement grounding never buys more than "medium" (see
   :func:`markers.surface_answer_confidence`). "high" continues to mean exactly
   what it has always meant: verified against a retrieved passage. So even if
   brake 1 misses a normative claim, the worst case is a hedge, not a
   confident legal assertion.

Brake 2 is the structural one and does not depend on any text heuristic. Brake 1
is behavioural and is the weaker of the two; it is deliberately written to
over-fire, because a false positive costs the honest hedge we already ship and a
false negative costs a claim about the law.

Note what brake 1 does NOT have to decide: whether a normative claim is
*supported*. The citation gate already answered that — this module is only ever
consulted when ``citation_grounded`` is False, i.e. when NOTHING in the answer
is citation-backed. So the question reduces to "does this answer touch
regulatory material at all", which is a far easier question than "is this
sentence a normative claim".

## The invariant this must not break

The measurement layer MEASURES; the Bestimmung JUDGES. No operator returns a
verdict, a threshold, „erfüllt" or a Gebäudeklasse. Nothing here may create a
route by which a measurement's evidence attaches itself to a judgment — which is
precisely what brake 1 exists to prevent, and why the vocabulary below includes
the verdict words (``erfüllt``, ``zulässig``, ``Gebäudeklasse``) that the
measurement layer is forbidden to emit: if they appear in the answer, they came
from the model, not from the file.
"""

from __future__ import annotations

import re

from aiq_agent.agents.bim.measurement_evidence import result_carries_measurement

from .tool_search import tool_basename

#: Tools whose results constitute a MEASUREMENT of the building.
#:
#: Only ``ifc_measure``. ``ifc_query`` is deliberately absent: it reads the
#: extracted index and its renderer carries no provenance contract, so a caller
#: cannot tell a published quantity from an inferred one by reading the result —
#: which is the whole basis on which measurement grounding is granted here.
#:
#: Matched on the tool's BASE name (``tool_search.tool_basename``): NAT delivers
#: a function-group or MCP tool as ``group__ifc_measure``, and an exact compare
#: against the bare name silently switched measurement grounding off for every
#: deployment that uses grouping — reinstating the "low" floor this whole gate
#: exists to lift, by nothing but topology.
MEASUREMENT_TOOL_NAMES: frozenset[str] = frozenset({"ifc_measure"})

#: Every error path in ``ifc_measure`` — rejected arguments, an unreachable
#: model service, a missing engine, an oversized file — returns a string opening
#: with this token. None of them carries the evidence trailer either (they never
#: reach the renderer); this is the second, cheaper check.
_TOOL_ERROR_PREFIX = "error:"


def tool_result_is_measurement(tool_name: str, content: str) -> bool:
    """Whether one tool result is a MEASUREMENT of the building.

    True only for a result from a tool in :data:`MEASUREMENT_TOOL_NAMES` whose
    own evidence trailer reports at least one ``declared``/``computed`` value
    (:mod:`aiq_agent.agents.bim.measurement_evidence`). A refusal, an outage, an
    ``inferred`` guess, and a ``decidable: false`` finding about the export are
    all False — none of them is a number anyone can stand behind, and treating
    them as evidence is the failure this whole gate exists to prevent.

    It reads the renderer's stated COUNT rather than searching the result for
    „gemessen"/„deklariert", because the renderer uses those verbs in prose that
    explains why nothing could be measured — „gemessen: raumhoehe an 0 von 3
    Bauteilen", „…dessen Höhe gemessen werden könnte". Under the old vocabulary
    match every one of those refusals granted grounding.
    """
    if tool_basename(tool_name) not in MEASUREMENT_TOOL_NAMES:
        return False
    text = (content or "").strip()
    if not text or text[: len(_TOOL_ERROR_PREFIX)].lower() == _TOOL_ERROR_PREFIX:
        return False
    return result_carries_measurement(text)


# ---------------------------------------------------------------------------
# Normative-claim detection (brake 1)
# ---------------------------------------------------------------------------
#
# A deliberately WIDE net over the vocabulary in which Austrian building law is
# asserted, plus the bare adequacy judgments that are the shortest way to smuggle
# a verdict past a reader („2,70 m — das reicht"). Tuned to over-fire: a false
# positive returns the answer to the "low" it already gets today, a false
# negative lets a legal claim ride at "medium".
#
# Two rules learned from measuring this list against a corpus of German verdict
# sentences, on which it missed 26 of 30:
#
# 1. **German compounds defeat a right-hand `\b`.** „geforderten", „normkonform"
#    and „Mindesthöhe" are the ordinary way the language says these things, and
#    `\bgefordert\b` matches none of them. So the stems below anchor on the LEFT
#    only. The left anchor stays — it is what keeps „Normalerweise" out of
#    „Norm".
# 2. **An ordinary verb is not a verdict.** `entspr(icht|echen)` was the single
#    biggest source of false fires — „das entspricht rund 14 % der Geschoßfläche"
#    is a measurement, and flooring it to "low" both re-hedged the answers this
#    module exists to un-hedge and filled the `confidence_capped` ledger with
#    cases nobody should act on. It is gone: every genuinely normative use of it
#    („entspricht der OIB-Richtlinie 3", „entspricht der Anforderung") names the
#    instrument it conforms to, and the instrument is already in this list.
#
# What is deliberately NOT here: descriptive superlatives a survey answer
# legitimately uses about its own numbers — „Mindestwert", „Höchstwert",
# „maximal", „die kleinste Raumhöhe". Those collide head-on with the measurement
# vocabulary this change exists to un-hedge, which is why `mindest` below carves
# „Mindestwert" back out: „Mindesthöhe" and „Mindestmaß" are the Bauordnung's
# words, „Mindestwert" is the survey renderer's.
_NORMATIVE_PATTERNS: tuple[str, ...] = (
    # --- Named instruments and the grammar of citing them --------------------
    r"\boib\b",
    r"\bö?norm(en)?\b",
    r"\boenorm\b",
    r"\bnorm(gerecht|konform)",
    r"\brichtlinie",
    r"\brl\s*\d",
    r"\bbauordnung",
    r"\bbaurecht",
    r"\bbautechnik(verordnung)?\b",
    r"\bverordnung",
    r"\bvorschrift",
    r"\bgesetz",
    r"§",
    r"\bpunkt\s+\d+\.\d",
    r"\babs\.\s*\d",
    r"\bbehörde",
    r"\bbehoerde",
    r"\bstand\s+der\s+technik\b",
    # --- Compliance verdicts -------------------------------------------------
    r"\berfüll",
    r"\berfuell",
    r"\beinzuhalten",
    r"\beingehalten",
    r"\beinhalt",
    r"\b(un)?zulässig",
    r"\b(un)?zulaessig",
    r"\berlaubt",
    r"\bvorgeschrieben",
    r"\bvorzusehen",
    r"\bgefordert",
    r"\bforderung",
    r"\banforderung",
    r"\berforderlich",
    r"\bgrenzwert",
    r"\bsollwert",
    r"konform",
    r"\bverstöß",
    r"\bverstoss",
    r"\bzwingend",
    r"\bdarf\b",
    r"\bgenehmigungs",
    r"\bbewilligungs",
    r"\bauflage[n]?\b",
    # --- Thresholds, and being on the wrong side of one ----------------------
    # „mindestens 2,50 m", „die Mindesthöhe wird unterschritten", „darf nicht
    # unter 2,50 m liegen" — the shape a height requirement is actually written
    # in, and the shape a breach of it is reported in.
    r"\bmindest(?!wert)",
    r"\bunterschr(eit|itt)",
    r"\bnicht\s+unter\b",
    r"\bnachweis",
    r"\bnachgewiesen",
    # --- Classifications the measurement layer is forbidden to emit ----------
    r"\bgebäudeklasse",
    r"\bgebaeudeklasse",
    r"\bgk\s*[1-5]\b",
    r"\bbrandschutzklasse",
    r"\bfeuerwiderstand",
    r"\bfluchtniveau\b",
    # --- Bare adequacy judgments ---------------------------------------------
    # The shortest route to a verdict, and the one a reader is least likely to
    # read as one. „reicht von … bis" is excluded: that is a RANGE, which is the
    # one thing a survey answer says about its own numbers.
    r"\bausreichend",
    r"\bunzureichend",
    r"\bgenüg",
    r"\bgeeignet",
    r"\breicht\b(?!\s+von\b)",
    r"\bzu\s+(niedrig|gering|klein|hoch|groß|gross|knapp|schmal|kurz|eng)\b",
    # --- English, for a model that switches language mid-answer --------------
    r"\bcompl(y|ies|iant|iance)\b",
    r"\brequir(e|es|ed|ement)",
    r"\bpermissible\b",
    r"\bbuilding\s+code\b",
    r"\bregulation",
    r"\bguideline",
    r"\bmandator",
    r"\bminimum\b",
    r"\bsufficient",
    r"\bfalls\s+short\b",
    r"\blimit\b",
)

_NORMATIVE_RE = re.compile("|".join(_NORMATIVE_PATTERNS), re.IGNORECASE)


def answer_mentions_normative_claim(content: str) -> bool:
    """Whether an answer touches regulatory material or passes a verdict.

    Consulted ONLY on answers that failed the citation gate — so "mentions" and
    "asserts without support" are the same thing here, and this does not have to
    tell a supported normative claim from an unsupported one.

    Wide by construction (see the module docstring): the cost of firing on
    „das entspricht 2,70 m" is the hedge the answer gets today, and the cost of
    NOT firing on „erfüllt damit OIB 4" is a legal claim at "medium". Non-string
    input is False — there is nothing to read, and the caller's other gates still
    apply.
    """
    if not isinstance(content, str) or not content:
        return False
    return bool(_NORMATIVE_RE.search(content))
