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
is behavioural and is the weaker of the two. It is biased towards firing — a
false negative costs a claim about the law, a false positive costs the hedge the
answer already gets — but "bias" is not "over-fire at any price": a brake that
fires on ``ifc_measure``'s own „für eine Messung geeignet" re-floors precisely
the measured answers this module exists to un-hedge, and fills the
``confidence_capped`` ledger with entries nobody should act on. Both directions
are measured, on corpora written without sight of the vocabulary
(``tests/…/test_grounding.py``): the brake misses none of 119 verdict sentences
and fires on 2 of 88 descriptive ones, both of them a renderer PREREQUISITE
phrased with „muss" („um X zu bestimmen, muss das Modell Y enthalten"). That
residue is the deliberate trade: no context disarms a deontic modal, so a
refusal gets hedged rather than a verdict slipping out.

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
# A wide net over the vocabulary in which Austrian building law is asserted, plus
# the bare adequacy judgments that are the shortest way to smuggle a verdict past
# a reader („2,70 m — das reicht"). It errs towards firing: a false negative
# lets a legal claim ride at "medium", which is the liability this whole module
# exists to prevent.
#
# Three rules, each learned from measuring the list against a corpus it had not
# been tuned on:
#
# 1. **German compounds defeat a `\b` on EITHER side.** „geforderten",
#    „normkonform" and „Mindesthöhe" need the right-hand anchor gone;
#    „Landesbauordnung", „Baugesetz" and „Bautechnikverordnung" — which is how
#    Austria actually names its law — need the LEFT one gone too. A stem that
#    keeps a left `\b` for safety (`\bnorm`, so „Normalerweise" stays out) is
#    the exception, not the rule, and each one below says why.
# 2. **An ordinary verb is not a verdict.** `entspr(icht|echen)` was the single
#    biggest source of false fires — „das entspricht rund 14 % der Geschoßfläche"
#    is a measurement, and flooring it to "low" both re-hedged the answers this
#    module exists to un-hedge and filled the `confidence_capped` ledger with
#    cases nobody should act on. It is gone: every genuinely normative use of it
#    („entspricht der OIB-Richtlinie 3", „entspricht der Anforderung") names the
#    instrument it conforms to, and the instrument is already in this list.
# 3. **Some stems are verdicts only outside the measurement's own prose.** The
#    renderers in :mod:`aiq_agent.agents.bim.measure_register` say „für eine
#    Messung geeignet", „für die Ermittlung … erforderlich" and „die Datei ist
#    zu groß" — every one of them a stem this list wants, used about the
#    APPARATUS rather than about the building. Those stems live in
#    :data:`_WEAK_NORMATIVE_PATTERNS` and are suppressed inside a sentence that
#    names the apparatus; everything else fires unconditionally.
#
# What is deliberately NOT here: descriptive superlatives a survey answer
# legitimately uses about its own numbers — „Mindestwert", „Höchstwert",
# „maximal", „die kleinste Raumhöhe". Those collide head-on with the measurement
# vocabulary this change exists to un-hedge, which is why `mindest` below carves
# „Mindestwert" back out: „Mindesthöhe" and „Mindestmaß" are the Bauordnung's
# words, „Mindestwert" is the survey renderer's. „mindestens" is carved out for
# the same reason and readmitted only in front of a QUANTITY — „mindestens
# 2,50 m" is a requirement, „mindestens drei Räume" is a count.

#: Stems that are normative wherever they appear. No context can make „muss",
#: „unzulässig" or „§ 118" a measurement.
_STRONG_NORMATIVE_PATTERNS: tuple[str, ...] = (
    # --- Named instruments and the grammar of citing them --------------------
    # Left-anchor-free, because the instrument is the RIGHT half of the compound
    # Austria actually writes: Landes|bauordnung, Bau|gesetz, Bautechnik|verordnung.
    r"\boib\b",
    r"\bö?norm(en)?\b",
    r"\boenorm\b",
    r"\bnorm(gerecht|konform)",  # keeps the left \b: „Normalerweise" is not „Norm"
    r"richtlinie",
    r"\brl\s*\d",
    r"bauordnung",
    r"\bbaurecht",
    r"bautechnik(verordnung)?\b",
    r"verordnung",
    r"vorschrift",
    r"gesetz(?!t)",  # „Baugesetz", „gesetzlich" — never „gesetzt"/„festgesetzt"
    r"§",
    r"\bpunkt\s+\d+\.\d",
    r"\babs\.\s*\d",
    # „der Behörde", „Baubehörde" — but „Behördenwege" is a trip to an office,
    # not a rule, so Behörde may be the right half of a compound and not the left.
    r"behörden?\b",
    r"behoerden?\b",
    r"\bstand\s+der\s+technik\b",
    # --- Austrian procedure --------------------------------------------------
    r"\bbauverhandlung",
    r"\banrainer",
    r"\beinwendung",
    r"\bwidmung",
    r"\bkonsens\b",
    r"bewillig",
    r"genehmig",
    r"\bversagung",
    r"pflicht",  # Bewilligungspflicht, Nachweispflicht, verpflichtet
    r"\bbedarf\s+(einer|eines|einem|einen|der|des)\b",  # the VERB; „der Bedarf an" is a quantity
    r"\bhaft(et|en|ung|bar)\b",
    r"statthaft",
    # --- Deontic modals ------------------------------------------------------
    # The commonest way either language states an obligation, and the widest gap
    # this list ever had: „muss" outranks every other verdict word in OIB prose
    # and used to match nothing at all.
    r"\bmu(ss|ß|ess)",
    r"\bmü(ss|ß)",
    r"\bdarf\b",
    r"\bdürf",
    r"\bduerf",
    r"\bsoll(en|te|ten)\b",  # not bare „Soll", which is „Soll-Ist-Vergleich"
    r"\bsoll\s+(mindestens|maximal|höchstens|hoechstens|nicht)\b",
    r"\bmust\b",
    r"\bshall\b",
    r"\bmay\s+not\b",
    r"\bnot\s+(permitted|allowed)\b",
    # --- „ist … zu tun": the zu-infinitive that carries most of the OIB -------
    # A separable prefix + „zu" + infinitive is a prescription and is almost
    # never anything else: einzuhalten, sicherzustellen, einzuholen, vorzusehen,
    # nachzureichen, anzuheben, abzuraten, freizuhalten, vorzulegen, beizubringen.
    # Enumerating the prefixes is what keeps „Geschoßzuordnungen" and „Nutzungen"
    # out; a bare `\w+zu\w+en` catches both.
    r"\b(ein|vor|nach|an|auf|aus|ab|bei|mit|her|hin|zurück|zurueck|frei|fest"
    r"|sicher|durch|über|ueber|unter|um|zusammen|nieder)zu\w+en\b",
    # …and the non-separable half of the same construction, which needs the
    # „ist/hat … zu" frame to tell „hat zu erfolgen" from „ist zu groß, um … zu
    # werden".
    r"\b(ist|sind|wäre|wären|waere|waeren|hat|haben)\b[^.!?\n]{0,80}?"
    r"\bzu\s+(erfolgen|beachten|erbringen|begrenzen|erhöhen|erhoehen"
    r"|gewährleisten|gewaehrleisten|unterlassen|reduzieren)\b",
    # --- Compliance verdicts -------------------------------------------------
    r"\berfüll",
    r"\berfuell",
    r"\beingehalten",
    r"\b(nicht)?einhalt",  # „Einhaltung", „Nichteinhaltung" — but not „beinhaltet"
    r"\b(un)?zulässig",
    r"\b(un)?zulaessig",
    r"\berlaubt",
    r"\bvorgeschrieben",
    r"\bgefordert",
    r"\bforderung",
    r"\banforderung",
    r"\bverlangt",
    r"\bgrenzwert",
    r"konform",
    r"\bverstöß",
    r"\bverstoss",
    r"\bwiderspr",  # „widerspricht der OIB-Richtlinie", „widersprechen"
    r"\bverfehl",  # „verfehlt das Kriterium um 9 cm" — a verdict with no stem
    r"\bzwingend",
    r"\bauflage[n]?\b",
    r"\bempfohlen",
    r"\bempfehl",
    # --- Thresholds, and being on the wrong side of one ----------------------
    # „mindestens 2,50 m", „die Mindesthöhe wird unterschritten", „darf nicht
    # unter 2,50 m liegen" — the shape a height requirement is actually written
    # in, and the shape a breach of it is reported in.
    r"\bmindest(?!ens|wert)",
    r"\bmindestens\s+(rund\s+|ca\.\s*|etwa\s+)?\d+([.,]\d+)?\s*(m\b|cm\b|mm\b|m²|m2\b|%|grad\b|w/)",
    r"\bunterschr(eit|itt)",
    r"\bnicht\s+unter\b",
    r"nachweis(e|es|en)?\b",  # „Brandschutznachweis"; not „Nachweisführung"
    r"\bnachgewiesen",
    # --- Classifications the measurement layer is forbidden to emit ----------
    r"\bgebäudeklasse",
    r"\bgebaeudeklasse",
    r"\bgk\s*[1-5]\b",
    r"brennbar",
    r"\bals\s+aufenthaltsraum\b",
    r"\bkeine?\s+aufenthaltsraum",
    r"\b(gilt|gelten|zählt|zaehlt|zählen|zaehlen)\b[^.!?\n]{0,40}?\bals\b",
    # --- Bare adequacy judgments ---------------------------------------------
    # The shortest route to a verdict, and the one a reader is least likely to
    # read as one.
    r"\bausreichend",
    r"\bunzureichend",
    r"\bgenüg",
    r"\bgenueg",
    # --- English, for a model that switches language mid-answer --------------
    r"\bcompl(y|ies|iant|iance)\b",
    r"\brequir(e|es|ed|ement)",
    r"\b(im)?permissible\b",
    r"\bbuilding\s+code\b",
    r"\bregulation",
    r"\bguideline",
    r"\bmandator",
    r"\bsufficient",
    r"\bfalls\s+short\b",
    r"\blimit\b",
    r"\bapprov(e|ed|al)\b",
    r"\bfails?\b[^.!?\n]{0,40}?\b(requirement|target|test|criterion|criteria)\b",
)

#: Stems that are a verdict about the BUILDING and a description of the
#: MEASUREMENT, depending on what the sentence is about. Each one below is a
#: documented false fire on near-verbatim ``ifc_measure`` output.
_WEAK_NORMATIVE_PATTERNS: tuple[str, ...] = (
    r"\bgeeignet",  # „als Aufenthaltsraum geeignet" vs „für eine Messung geeignet"
    r"\berforderlich",  # a legal requirement vs a tool prerequisite
    r"\bsollwert",  # „liegt unter dem Sollwert" vs „der Sollwert aus dem Pset"
    # „reicht" is „suffices" only when nothing extends: „reicht von … bis",
    # „reicht vom Rohfußboden", „reicht 1,20 m über … hinaus" are all geometry.
    r"\breicht\b(?![^.!?\n]*\b(von|vom|bis|über|ueber|hinaus|hinein|herab|herauf|hinunter)\b)",
    r"\bzu\s+(niedrig|gering|klein|hoch|groß|gross|knapp|schmal|kurz|eng|wenig|lang|breit|steil|tief|weit)\b",
    r"\btoo\s+(low|small|narrow|short|high|large|wide|long|steep|few|little)\b",
    r"\bminimum\b",  # a requirement vs „the minimum of the series"
    # Fire-safety and escape-route categories: a verdict when asserted of the
    # building, a gap report when the renderer says it cannot compute them.
    r"\bfluchtniveau",
    r"\bfluchtweg",
    r"\bfeuerwiderstand",
    r"\bbrandschutz",
    r"\bbrandabschnitt",
)

#: The measurement APPARATUS naming itself. Narrow on purpose — every entry is
#: here to disarm one concrete false fire, and nothing else. In particular
#: „gemessen"/„berechnet"/„deklariert" are ABSENT: a measured number is exactly
#: what a verdict gets passed on, so „die gemessene Höhe ist zu wenig" must
#: still fire.
_MEASUREMENT_APPARATUS_PATTERNS: tuple[str, ...] = (
    r"\bmess",  # Messung, Messpunkt, Messachse, Messwert — not „gemessen"
    r"\bermittl",  # „Für die Ermittlung … ist … erforderlich"
    r"\bauswertung",
    r"berechnung",  # „für eine Volumenberechnung nicht geeignet"
    r"\bberechnen\b",
    r"\bbema(ß|ss)",  # „zu klein bemaßt", „die Bemaßung"
    r"\bdatei",  # „Die Datei ist zu groß"
    r"\bpset",  # „der Sollwert aus dem Pset"
    r"\bdeklaration",
    r"\bfile\b",  # „The file is too large"
    r"\bseries\b",  # „the minimum of the series"
)

_STRONG_NORMATIVE_RE = re.compile("|".join(_STRONG_NORMATIVE_PATTERNS), re.IGNORECASE)
_WEAK_NORMATIVE_RE = re.compile("|".join(_WEAK_NORMATIVE_PATTERNS), re.IGNORECASE)
_MEASUREMENT_APPARATUS_RE = re.compile("|".join(_MEASUREMENT_APPARATUS_PATTERNS), re.IGNORECASE)

#: Sentence boundaries for the weak-stem check. A semicolon is NOT one: German
#: uses it to join the two halves of a single statement („Das Modell ist zu groß
#: für den Schnellpfad; die Messung lief im Vollpfad"), and splitting there would
#: hide the apparatus from the stem it qualifies.
_SENTENCE_SPLIT_RE = re.compile(r"[.!?\n]+")


def answer_mentions_normative_claim(content: str) -> bool:
    """Whether an answer touches regulatory material or passes a verdict.

    Consulted ONLY on answers that failed the citation gate — so "mentions" and
    "asserts without support" are the same thing here, and this does not have to
    tell a supported normative claim from an unsupported one.

    Two tiers. A :data:`_STRONG_NORMATIVE_PATTERNS` stem fires wherever it
    appears; a :data:`_WEAK_NORMATIVE_PATTERNS` stem fires unless its own
    SENTENCE names the measurement apparatus, which is how the renderer's
    „für eine Messung geeignet" stops reading as a habitability verdict.

    The asymmetry is deliberate and is the trade this function makes: the weak
    tier holds only stems that appear verbatim in ``ifc_measure`` output, and no
    context of any kind can disarm a deontic modal or a named instrument. So the
    worst case remains a hedge on a descriptive answer, never a confident legal
    assertion — see the module docstring. Non-string input is False; there is
    nothing to read, and the caller's other gates still apply.
    """
    if not isinstance(content, str) or not content:
        return False
    if _STRONG_NORMATIVE_RE.search(content):
        return True
    return any(
        _WEAK_NORMATIVE_RE.search(sentence) and not _MEASUREMENT_APPARATUS_RE.search(sentence)
        for sentence in _SENTENCE_SPLIT_RE.split(content)
    )
