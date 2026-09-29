"""An answer's own prose, without the reference list under it.

Shared by the answer pipeline (the normative brake, the card floor) and the
post-answer stages' gates, which read the finished answer: a bibliography
asserts nothing, ends in no question and says nothing about insufficiency.
"""

from __future__ import annotations

import re

#: A trailing reference list, in the headings this agent and the models it runs
#: actually produce.
REFERENCES_SECTION_RE = re.compile(
    r"\n\s*(?:\*\*(?:References|Sources|Quellen):?\*\*|#{2,3}\s+(?:References|Sources|Quellen))\s*(?:\n|$)",
    re.IGNORECASE,
)

#: What a reference list is allowed to consist of: a blank line, or a line that
#: carries an actual REFERENCE, a URL or a „[n]" citation marker. List
#: punctuation is not enough and never was: „- " is available to any sentence,
#: so accepting it let „- Damit ist der Raum unzulässig …" under a
#: „**Quellen:**" heading count as a bibliography entry and leave the text
#: before the brake ever read it.
REFERENCE_LINE_RE = re.compile(r"^\s*$|\[\d+\]|<?https?://")


def prose_without_references(content: str) -> str:
    """The answer's own sentences, with any trailing reference list removed.

    The normative brake judges what the ANSWER asserts, and a bibliography
    asserts nothing. It matters because of where that line comes from: the
    single-source fallback appends it, so leaving it in made every
    fallback-grounded answer read as normative and floored measured,
    purely descriptive answers to "low" under a reason that was not true of a
    single sentence the model wrote.

    Only a genuinely TRAILING list is cut: a heading is a cut point only when
    every line after it points at a source (a URL or a „[n]" marker) or is
    blank; otherwise the search moves to the previous heading, and failing
    that nothing is removed. Erring towards keeping text is the safe
    direction: a reference line that survives costs a hedge, a verdict that
    is dropped costs a claim about the law.

    Known gap, left open deliberately: ANY tail line carrying a URL or a „[n]"
    marker is cut, so a verdict smuggled into an all-references tail with a
    marker on it („- Damit ist der Raum unzulässig [1]") is cut too. Keeping
    the lines the normative brake fires on was measured and is inverted: a
    compliance bibliography is a list of exactly the instrument names the
    brake's strong tier matches (11 of 14 genuine entries fire, including the
    line this module appends itself). A real finite-verb test needs a POS
    tagger; a heuristic that cuts the wrong way is worse than the gap.
    """
    if not isinstance(content, str):
        return ""
    for match in reversed(list(REFERENCES_SECTION_RE.finditer(content))):
        tail = content[match.end() :]
        if all(REFERENCE_LINE_RE.search(line) for line in tail.splitlines()):
            return content[: match.start()]
    return content
