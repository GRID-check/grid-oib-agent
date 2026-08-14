"""What a measurement result says about ITSELF — the one machine-readable fact.

``ifc_measure``'s renderer and the confidence gate in
:mod:`aiq_agent.agents.shallow_researcher.grounding` need to agree on a single
question: **did this result actually measure anything?** They used to agree by
vocabulary — the gate searched the whole rendered string for „gemessen" or
„deklariert" — and that is not a contract, it is a coincidence. The renderer
writes those words in prose that explains why nothing COULD be measured:

    „gemessen: raumhoehe an 0 von 3 Bauteilen."
    „Abhilfe: … ohne Geschoßebenen gibt es kein Fußbodenniveau, dessen Höhe
     gemessen werden könnte."

Both are refusals. Both used to grant measurement grounding, which is the exact
failure the grounding gate exists to prevent: a model that invents „rund 9,5 m"
on top of a refused measurement surfaced at "medium" with nothing behind it.

So the renderer states the fact instead of implying it. Every ``ifc_measure``
result ends with one line saying how many values in it carry a ``declared`` or
``computed`` provenance, and the gate reads that line — the LAST line, so no
room name, remedy sentence or briefing text out of the IFC file can forge it.
The count is derived from the payload's own ``decidable``/``provenance`` fields,
never from the German around them.

It is a sentence rather than an opaque token because the model reads this string
too: „Messwerte in diesem Ergebnis: 0" is a useful thing for the agent to be
told before it writes „rund 9,5 m", and an echo of it into an answer is at worst
true.
"""

from __future__ import annotations

import re

#: The provenances that constitute EVIDENCE. ``inferred`` is excluded on
#: purpose — the renderer calls it „ein Vorschlag zur Bestätigung, keine
#: Feststellung", and a heuristic must not raise anybody's confidence.
EVIDENCE_PROVENANCES: frozenset[str] = frozenset({"declared", "computed"})

#: The opening of the trailer line. Changing it changes the contract, and
#: ``tests/aiq_agent/agents/shallow_researcher/test_grounding.py`` pins both
#: sides of it against real renderer output.
MEASUREMENT_EVIDENCE_PREFIX = "Messwerte in diesem Ergebnis:"

_EVIDENCE_LINE_RE = re.compile(rf"^{re.escape(MEASUREMENT_EVIDENCE_PREFIX)}\s+([1-9]\d*)\b")


def measurement_evidence_line(count: int) -> str:
    """The trailer every rendered ``ifc_measure`` result carries.

    ``count`` is the number of values in the result whose provenance is in
    :data:`EVIDENCE_PROVENANCES`. Zero is stated, not omitted: a result that
    measured nothing has to say so, both to the reader and to the gate.
    """
    if count <= 0:
        return f"{MEASUREMENT_EVIDENCE_PREFIX} 0 — keine Angabe mit Herkunft deklariert oder gemessen."
    noun = "Messwert" if count == 1 else "Messwerte"
    return f"{MEASUREMENT_EVIDENCE_PREFIX} {count} {noun} mit Herkunft deklariert oder gemessen."


def result_carries_measurement(content: str) -> bool:
    """Whether a tool result's own trailer reports at least one measured value.

    Reads the LAST line only. The rest of a result is IFC-derived text — room
    names, remedy sentences, briefing prose — and anchoring anywhere else would
    let a file's contents claim evidence the engine never produced. A result
    without the trailer (an error string, an image block, anything not written
    by ``measure_register._render``) is False: the gate fails closed, and the
    failure direction is the hedge, never a confident number.
    """
    text = (content or "").strip()
    if not text:
        return False
    return bool(_EVIDENCE_LINE_RE.match(text.rsplit("\n", 1)[-1].strip()))
