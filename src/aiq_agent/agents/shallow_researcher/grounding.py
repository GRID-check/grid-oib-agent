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

#: Tools whose results constitute a MEASUREMENT of the building.
#:
#: Only ``ifc_measure``. ``ifc_query`` is deliberately absent: it reads the
#: extracted index and its renderer carries no provenance contract, so a caller
#: cannot tell a published quantity from an inferred one by reading the result —
#: which is the whole basis on which measurement grounding is granted here.
MEASUREMENT_TOOL_NAMES: frozenset[str] = frozenset({"ifc_measure"})

#: The provenance verbs ``ifc_measure``'s renderer puts in front of every
#: answer (``measure_register._provenance_line``), restricted to the two that
#: constitute EVIDENCE:
#:
#:   ``deklariert``  the file states it — wrong only if the export is wrong;
#:   ``gemessen``    computed from the geometry, and the tolerance travels along.
#:
#: ``vermutlich`` (provenance ``inferred``) is excluded on purpose. The renderer
#: calls it „ein Vorschlag zur Bestätigung, keine Feststellung" — a heuristic is
#: exactly the kind of thing that must not raise anybody's confidence. So is
#: ``NICHT ENTSCHEIDBAR``, which is a finding about the EXPORT and carries no
#: number at all.
#:
#: Coupled to the renderer's German by nothing but this regex, so
#: ``tests/aiq_agent/agents/shallow_researcher/test_grounding.py`` pins it
#: against ``_provenance_line``'s real output for all four cases. Drift shows up
#: as a red test, and the failure direction if it ever slips past is the old
#: over-hedging, never a confident answer.
_GROUNDING_PROVENANCE_RE = re.compile(r"\b(deklariert|gemessen)\b", re.IGNORECASE)

#: Every error path in ``ifc_measure`` — rejected arguments, an unreachable
#: model service, a missing engine, an oversized file — returns a string opening
#: with this token. None of them carries a provenance verb either; this is the
#: second, cheaper check.
_TOOL_ERROR_PREFIX = "error:"


def tool_result_is_measurement(tool_name: str, content: str) -> bool:
    """Whether one tool result is a MEASUREMENT of the building.

    True only for a result from a tool in :data:`MEASUREMENT_TOOL_NAMES` that
    actually answered with a ``declared`` or ``computed`` provenance line. A
    refusal, an outage, an ``inferred`` guess, and a ``decidable: false`` finding
    about the export are all False — none of them is a number anyone can stand
    behind, and treating them as evidence is the failure this whole gate exists
    to prevent.
    """
    if tool_name not in MEASUREMENT_TOOL_NAMES:
        return False
    text = (content or "").strip()
    if not text or text[: len(_TOOL_ERROR_PREFIX)].lower() == _TOOL_ERROR_PREFIX:
        return False
    return bool(_GROUNDING_PROVENANCE_RE.search(text))


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
# What is deliberately NOT here: descriptive superlatives a survey answer
# legitimately uses about its own numbers — „Mindestwert", „Höchstwert",
# „maximal", „die kleinste Raumhöhe". Those collide head-on with the measurement
# vocabulary this change exists to un-hedge, and the normative senses of each
# („höchstzulässig", „Mindestanforderung") are already caught by `zulässig`,
# `anforderung` and `erforderlich`.
_NORMATIVE_PATTERNS: tuple[str, ...] = (
    # --- Named instruments and the grammar of citing them --------------------
    r"\boib\b",
    r"\bö?norm(en)?\b",
    r"\boenorm\b",
    r"\brichtlinie",
    r"\brl\s*\d",
    r"\bbauordnung",
    r"\bbautechnik(verordnung)?\b",
    r"\bverordnung",
    r"\bvorschrift",
    r"\bgesetz",
    r"§",
    r"\bpunkt\s+\d+\.\d",
    r"\babs\.\s*\d",
    # --- Compliance verdicts -------------------------------------------------
    r"\berfüll",
    r"\berfuell",
    r"\bentspr(icht|echen|echend)\b",
    r"\beinzuhalten\b",
    r"\beingehalten\b",
    r"\beinhalt",
    r"\b(un)?zulässig",
    r"\b(un)?zulaessig",
    r"\bvorgeschrieben\b",
    r"\bgefordert\b",
    r"\bforderung",
    r"\banforderung",
    r"\berforderlich",
    r"\bgrenzwert",
    r"\bkonform\b",
    r"\bverstöß",
    r"\bverstoss",
    r"\bzwingend\b",
    r"\bgenehmigungs",
    r"\bbewilligungs",
    r"\bauflage[n]?\b",
    # --- Classifications the measurement layer is forbidden to emit ----------
    r"\bgebäudeklasse",
    r"\bgebaeudeklasse",
    r"\bgk\s*[1-5]\b",
    r"\bbrandschutzklasse",
    r"\bfeuerwiderstand",
    r"\bfluchtniveau\b",
    # --- Bare adequacy judgments ---------------------------------------------
    r"\bausreichend",
    r"\bunzureichend",
    r"\bgenügt\b",
    r"\bgenügend\b",
    r"\bzu\s+(niedrig|gering|klein|hoch|groß|gross)\b",
    # --- English, for a model that switches language mid-answer --------------
    r"\bcompl(y|ies|iant|iance)\b",
    r"\brequirement",
    r"\bpermissible\b",
    r"\bbuilding\s+code\b",
    r"\bregulation",
    r"\bmandator",
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
