"""The consolidated-text paragraph grammar: §§, Absätze, headings.

RIS's plain text is positional, so this is: a line beginning ``§ 63.`` opens a
section and everything up to the next such line is its body; an Absatz marker
``(1)`` opens an Absatz, either on its own line or run into the section head.
Nothing here knows about questions, LLMs or the tool — it splits text and cuts
text, which is why every extraction test can be written against it directly.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from knowledge_layer.register import _CHUNK_TRUNCATE_CHARS as PASSAGE_MAX_CHARS

#: The bound for a § the caller NAMED. A § is what a lawyer cites and what the
#: agent asked for; cut at the corpus chunk bound above, § 63 BO Wien arrived
#: as its first fifth and the agent spent three more lookups asking for the
#: rest. 8000 characters (about 2k tokens) holds 187 of the 194 §§ of the
#: Bauordnung für Wien whole; a ranked pick the agent did not name keeps the
#: chunk bound.
SECTION_MAX_CHARS = 8000

#: § headings listed per document, for the picker and for a miss.
MAX_HEADINGS = 120

#: A line that STARTS a section of a consolidated law: "§ 63.", "§ 63a.",
#: "Artikel 5", "Art. 5". RIS renders each of them as its own line. The number
#: ends in a period or ends the line: "§ 65 Abs. 2 gilt sinngemäß." is a
#: sentence that happens to open with a cross-reference, and read as a section
#: start it replaced § 65 itself wherever a lookup kept the last § of a label.
SECTION_LINE_RE = re.compile(r"^\s*(?:(§)+\s*|(Art)(?:ikel)?\.?\s*)(\d+[a-z]?)\s*(?:\.|$)", re.IGNORECASE)
#: An Absatz marker at the start of a line — the boundary a passage is cut on.
ABSATZ_LINE_RE = re.compile(r"(?m)^\(\s*(\d+[a-z]?)\s*\)")
#: The same marker where RIS runs it into the section head: "§ 63. (1) Dem …".
ABSATZ_INLINE_RE = re.compile(r"^\s*(?:§|Art(?:ikel)?\.?)\s*\d+[a-z]?\s*\.?\s*\(\s*(\d+[a-z]?)\s*\)")
#: A line that can serve as a section's Überschrift: short, and not a sentence.
_HEADING_MAX_CHARS = 120


@dataclass(frozen=True)
class Section:
    """One § / Artikel of a consolidated law, as the document states it."""

    kind: str
    number: str
    heading: str
    body: str

    @property
    def label(self) -> str:
        """``§ 63`` — empty for a document with no § grammar (a court decision)."""
        return f"{self.kind} {self.number}" if self.kind and self.number else ""


def split_sections(text: str) -> list[Section]:
    """Split a consolidated law into its §§ / Artikel, in document order.

    The preceding short line, when it reads as a heading, is recorded as the
    section's Überschrift — and left in the previous body too, because guessing
    wrong about a heading must not DELETE text a citation rests on.
    """
    lines = text.splitlines()
    starts = [(index, match) for index, line in enumerate(lines) if (match := SECTION_LINE_RE.match(line))]
    sections = [
        Section(
            kind="§" if match.group(1) else "Art",
            number=match.group(3),
            heading=_heading_above(lines, index) or _heading_below(lines, index),
            body="\n".join(lines[index : _end_of(starts, position, len(lines))]).strip(),
        )
        for position, (index, match) in enumerate(starts)
    ]
    # A bare "Artikel 5" line ABOVE the section it names matches this grammar
    # too, and would otherwise contribute a section with no text in it. A
    # section whose body is only its own marker is a heading, not a provision.
    return _one_section_per_label([section for section in sections if _has_text(section)])


def _one_section_per_label(sections: list[Section]) -> list[Section]:
    """One section per §: the one that carries the provision.

    RIS states a § more than once. The Bauordnung für Wien prints a header
    block (``§ 63`` / ``Text`` / Überschrift) before every provision: 183 of
    its 388 parsed sections were such stubs. The Tiroler Bauordnung opens with
    a table of contents, ``§ 8`` / ``Abstellmöglichkeiten für Kraftfahrzeuge``,
    far from § 8 itself. Each stub matches the grammar, so a lookup for § 63
    returned it as a passage of its own and registered the same citation key
    twice. The longest body is the provision; the others go, and so does their
    "heading", which is whatever line sat above them (in a table of contents,
    the previous entry's title).
    """
    longest: dict[str, Section] = {}
    for section in sections:
        kept = longest.get(section.label)
        if section.label and (kept is None or len(section.body) > len(kept.body)):
            longest[section.label] = section
    return [section for section in sections if not section.label or longest[section.label] is section]


def _end_of(starts: list[tuple[int, object]], position: int, total: int) -> int:
    """Where one section's body stops: at the next section, or at the end."""
    return starts[position + 1][0] if position + 1 < len(starts) else total


def _heading_above(lines: list[str], index: int) -> str:
    """The Überschrift on the line above a section start, when there is one."""
    previous = lines[index - 1].strip() if index > 0 else ""
    return previous if _is_heading(previous) else ""


def _heading_below(lines: list[str], index: int) -> str:
    """The Überschrift on the line after the marker, where a law puts it there.

    The Tiroler Bauordnung writes ``§ 8`` / ``Abstellmöglichkeiten für
    Kraftfahrzeuge`` / ``(1)``; read only above, its index was bare numbers and
    the picker, which chooses by heading, chose blind.
    """
    below = lines[index + 1].strip() if index + 1 < len(lines) else ""
    return below if _is_heading(below) and not ABSATZ_LINE_RE.match(below) else ""


def _has_text(section: Section) -> bool:
    """Whether a section carries anything beyond its own ``§ 63.`` marker."""
    return bool(SECTION_LINE_RE.sub("", section.body, count=1).strip())


def _is_heading(line: str) -> bool:
    """Whether a line reads as an Überschrift rather than as a sentence."""
    if not line or len(line) > _HEADING_MAX_CHARS:
        return False
    return not line.endswith((".", ":", ",", ";")) and not SECTION_LINE_RE.match(line)


def absatz_body(section: Section, absatz: str) -> tuple[str, str]:
    """``(body, absatz)`` narrowed to one Absatz, or the whole section.

    An Absatz the document does not carry returns the section unchanged: the
    honest answer to "§ 63 Abs 9" in a § with three Absätze is § 63, never an
    empty passage and never the wrong Absatz.
    """
    if not absatz or not section.number:
        return section.body, ""
    marks = _absatz_marks(section.body)
    for position, (number, start) in enumerate(marks):
        if number.lower() != absatz.lower():
            continue
        end = marks[position + 1][1] if position + 1 < len(marks) else len(section.body)
        return section.body[start:end].strip(), number
    return section.body, ""


def _absatz_marks(body: str) -> list[tuple[str, int]]:
    """``(absatz, offset)`` for every Absatz marker, the run-in one included."""
    marks = [(match.group(1), match.start()) for match in ABSATZ_LINE_RE.finditer(body)]
    inline = ABSATZ_INLINE_RE.match(body)
    if inline:
        marks.insert(0, (inline.group(1), 0))
    return marks


def cut_on_absatz(text: str, limit: int = PASSAGE_MAX_CHARS) -> str:
    """Truncate a passage on an Absatz boundary, never mid-Absatz.

    The default bound is the knowledge layer's own ``_CHUNK_TRUNCATE_CHARS``
    (imported, never restated); ``passages._passage_limit`` passes the named-§
    or list budget instead. The marker is the knowledge layer's own
    ``... [truncated]``, so the citation parser strips it back off exactly as it
    does for a corpus chunk.
    """
    if len(text) <= limit:
        return text
    window = text[:limit]
    marks = [match.start() for match in ABSATZ_LINE_RE.finditer(window)]
    cut = marks[-1] if marks and marks[-1] > limit // 2 else window.rfind("\n")
    return text[: cut if cut > 0 else limit].rstrip() + "... [truncated]"


def headings_index(sections: list[Section]) -> str:
    """The § headings of one document, as the picker (and a miss) sees them."""
    shown = sections[:MAX_HEADINGS]
    lines = [f"{section.label}{f' — {section.heading}' if section.heading else ''}" for section in shown]
    if len(sections) > len(shown):
        lines.append(f"… and {len(sections) - len(shown)} more §§ (index truncated)")
    return "\n".join(lines)
