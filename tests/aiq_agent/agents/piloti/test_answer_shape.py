"""A mindmap that only redraws a table in the same answer is removed."""

from __future__ import annotations

from aiq_agent.agents.piloti.answer_shape import drop_restated_mindmaps

TABLE = "| Teil | Gilt für |\n|---|---|\n| RL 2.1 | Betriebsbauten |\n| RL 2.2 | Garagen |"
FLAT = '```mermaid\nmindmap\n  root(("OIB-RL 2"))\n    "Betriebsbauten"\n    "Garagen"\n```'
DEEP = (
    '```mermaid\nmindmap\n  root(("OIB-RL 2"))\n    "RL 2.1"\n      "Brandabschnitte nach Fläche"\n'
    '    "RL 2.2"\n      "Stellplätze und Parkdecks"\n```'
)
#: The September 2026 census: a second level that only repeats each part's number.
NUMBERED = (
    '```mermaid\nmindmap\n  root(("OIB-RL 2"))\n    "Betriebsbauten"\n      "RL 2.1"\n'
    '    "Garagen"\n      "RL 2.2"\n```'
)


def test_a_flat_mindmap_beside_a_table_goes():
    out, dropped = drop_restated_mindmaps(f"Einleitung.\n\n{TABLE}\n\n{FLAT}\n\nSchluss.")
    assert dropped == 1
    assert "mindmap" not in out and "Schluss." in out and TABLE in out


def test_a_level_that_only_repeats_the_table_still_goes():
    assert drop_restated_mindmaps(f"{TABLE}\n\n{NUMBERED}")[1] == 1


def test_a_mindmap_that_says_what_the_table_does_not_stays():
    content = f"{TABLE}\n\n{DEEP}"
    assert drop_restated_mindmaps(content) == (content, 0)


def test_a_flat_mindmap_without_a_table_stays():
    content = f"Einleitung.\n\n{FLAT}"
    assert drop_restated_mindmaps(content) == (content, 0)


def test_other_diagrams_are_not_touched():
    flow = "```mermaid\nflowchart TD\n  A --> B\n```"
    content = f"{TABLE}\n\n{flow}"
    assert drop_restated_mindmaps(content) == (content, 0)
