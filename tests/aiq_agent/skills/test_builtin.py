"""Builtin skill discovery — the 5 shipped SKILL.md files, strictly parsed."""

from __future__ import annotations

from pathlib import Path

import pytest

from aiq_agent.skills.builtin import BUILTIN_SKILLS_DIR
from aiq_agent.skills.builtin import discover_builtin_skills
from aiq_agent.skills.models import SkillValidationError

EXPECTED = {
    ("bim", "ifc-spatial-reasoning"),
    ("research", "data-table-analysis"),
    ("research", "forecast-analysis"),
    ("research", "lightweight-calculation"),
    ("synthesis", "long-form-report-writer"),
    ("synthesis", "prediction-report-writer"),
}


def test_builtin_dir_layout() -> None:
    assert BUILTIN_SKILLS_DIR.name == "builtin"
    assert BUILTIN_SKILLS_DIR.parent.name == "skills"
    assert (BUILTIN_SKILLS_DIR.parent.parent / "agents").is_dir()


def test_discovery_finds_every_builtin_skill() -> None:
    skills = discover_builtin_skills()
    assert {(s.collection, s.name) for s in skills} == EXPECTED
    assert len(skills) == len(EXPECTED)
    # Deterministic order: (collection, name) sorted.
    assert [s.name for s in skills if s.collection == "research"] == [
        "data-table-analysis",
        "forecast-analysis",
        "lightweight-calculation",
    ]


def test_discovery_parses_metadata_and_body() -> None:
    by_name = {s.name: s for s in discover_builtin_skills()}
    skill = by_name["long-form-report-writer"]
    assert skill.origin == "platform"
    assert skill.description
    assert skill.body.startswith("#")
    assert len(skill.body) > 0


def test_builtin_frontmatter_declares_only_its_audience() -> None:
    """Every builtin says WHO may use it, and nothing about when or how it runs.

    ``grid-agents: deep_researcher`` is the single reason these stay out of a
    chat turn — their instructions call ``execute`` and write ``/shared/``, which
    only exist inside a deep-research job. The scheduling keys that used to sit
    beside it (``grid-execution``, ``grid-schedulable``) are gone from the model,
    so a builtin file must not reintroduce them.
    """
    for skill in discover_builtin_skills():
        assert set(skill.metadata) <= {"grid-agents", "grid-cards"}, skill.name
        assert skill.metadata.get("grid-agents"), skill.name

    # The research and synthesis builtins are deep-research-only for a concrete
    # reason: their instructions call `execute` and write `/shared/`, which exist
    # nowhere else. `grid-agents` is the single gate that keeps them out of a
    # chat turn, so it must stay exact for them.
    by_name = {s.name: s for s in discover_builtin_skills()}
    for name in ("data-table-analysis", "long-form-report-writer"):
        assert by_name[name].metadata == {"grid-agents": "deep_researcher"}, name

    # `ifc-spatial-reasoning` is the exception that made this assertion general:
    # it teaches how to READ a tool's answers, needs none of that machinery, and
    # is worth nothing if the chat agent cannot carry it — which is where the
    # questions it is about get asked.
    spatial = by_name["ifc-spatial-reasoning"]
    assert "shallow_researcher" in spatial.metadata["grid-agents"]


def test_discovery_rejects_name_mismatch(tmp_path: Path) -> None:
    root = tmp_path / "builtin"
    skill_dir = root / "research" / "wrong-name"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: right-name\ndescription: okay\n---\nbody\n",
        encoding="utf-8",
    )
    with pytest.raises(SkillValidationError, match="directory name"):
        discover_builtin_skills(root)


def test_discovery_missing_dir() -> None:
    with pytest.raises(FileNotFoundError):
        discover_builtin_skills(BUILTIN_SKILLS_DIR / "nonexistent")
