"""Parse the ``(file_name, page)`` units an agent answer actually cited. PURE.

The knowledge tool formats every hit as ``"{file_name}, p.{page}"`` (see
``_format_results`` in ``knowledge_layer.register``) and the answer's References section
repeats that shape, so this is the one place the harness has to know about the citation
string. Kept in a NAT-free module so it can be unit-tested offline and so the NAT
evaluator stays a thin wrapper.

An answer's citations are NOT the same thing as retrieval's top-k: the model sees k chunks
and cites a handful. Scoring them measures the end-to-end grounding, which is a different
question from "was the right Punkt in the context window" — the runner answers that one.
"""

from __future__ import annotations

import re

#: ``oib-rl_2_ausgabe_mai_2023.pdf, p.13`` and the qualified form the ambiguous-name path
#: emits: ``Plan.pdf (Projektwissen), p.3``. The qualifier is discarded — it names the
#: collection, not the document, and a unit is a document page.
_CITATION_RE = re.compile(
    r"(?P<file>[A-Za-z0-9][\w.\-]*\.(?:pdf|PDF))(?:\s*\([^)]*\))?\s*,\s*p\.\s*(?P<page>\d+)",
)


def extract_units(text: str | None) -> list[tuple[str, int]]:
    """Cited ``(file_name, page)`` units in order of first appearance, deduplicated.

    Order matters: the metrics treat the list as a ranking, and the order an answer cites
    its sources in is the closest thing to a ranking an answer has.
    """
    if not text:
        return []
    units: list[tuple[str, int]] = []
    seen: set[tuple[str, int]] = set()
    for match in _CITATION_RE.finditer(text):
        unit = (match.group("file"), int(match.group("page")))
        if unit in seen:
            continue
        seen.add(unit)
        units.append(unit)
    return units
