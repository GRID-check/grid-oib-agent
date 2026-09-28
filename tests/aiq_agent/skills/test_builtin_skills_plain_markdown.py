"""A builtin skill that deep research loads teaches no answer dialect.

Deep research files its report as a PDF, and until Phase B the PDF pipeline
draws no ``:::`` block: it prints the fence lines as text
(``docs/design/answer-richness.md``, "Deep research waits for the PDF"). A skill
whose ``grid-agents`` names ``deep_researcher`` is read by that writer, so it
names a shape in words („Prüftabelle mit Status-Spalte") and the chat prompt's
RICH BLOCKS maps the shape to its block.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

BUILTIN = Path(__file__).resolve().parents[3] / "src" / "aiq_agent" / "skills" / "builtin"
DIALECT = re.compile(r":::|:(?:energy-class|project|current|applies|recommended)\b")


def _deep_skills() -> list[Path]:
    found = []
    for path in sorted(BUILTIN.rglob("SKILL.md")):
        text = path.read_text(encoding="utf-8")
        head = text.split("---", 2)[1] if text.startswith("---") else ""
        if re.search(r"grid-agents:.*\bdeep_researcher\b", head):
            found.append(path)
    return found


def test_there_are_deep_research_skills_to_check():
    assert _deep_skills()


@pytest.mark.parametrize("path", _deep_skills(), ids=lambda path: path.parent.name)
def test_a_deep_research_skill_teaches_no_dialect(path: Path):
    hits = [line for line in path.read_text(encoding="utf-8").splitlines() if DIALECT.search(line)]
    assert not hits, f"{path.relative_to(BUILTIN)} teaches the chat dialect to deep research: {hits}"
